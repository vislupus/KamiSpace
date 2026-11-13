"""Authentication, sessions, CSRF and registration."""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import select, update

from app.config import get_settings
from app.db import session_scope, utcnow
from app.models import AuditEvent, User, UserSession
from tests.conftest import PASSWORD, make_user


def test_login_sets_httponly_session_cookie(anon):
    make_user("alice")
    response = anon.login("alice")
    assert response.status_code == 200
    cookie = response.headers["set-cookie"].lower()
    assert "minddock_session=" in cookie
    assert "httponly" in cookie
    assert "samesite=lax" in cookie
    assert response.json()["user"]["username"] == "alice"
    assert "password_hash" not in response.text


def test_login_works_with_email_and_is_case_insensitive(anon):
    make_user("alice")
    assert anon.login("Alice@Example.com").status_code == 200


def test_login_rejects_bad_credentials_with_same_message(anon):
    make_user("alice")
    wrong_password = anon.login("alice", "not the password")
    unknown_user = anon.login("nobody", "not the password")
    assert wrong_password.status_code == unknown_user.status_code == 401
    assert wrong_password.json() == unknown_user.json()


def test_passwords_are_hashed_with_argon2(alice):
    with session_scope() as db:
        password_hash = db.execute(select(User.password_hash)).scalar_one()
    assert password_hash.startswith("$argon2id$")
    assert PASSWORD not in password_hash


def test_session_token_is_not_stored_in_plain_text(alice):
    token = alice.http.cookies.get(get_settings().session_cookie_name)
    with session_scope() as db:
        stored = db.execute(select(UserSession.token_hash)).scalar_one()
    assert token and token != stored and len(stored) == 64


def test_api_requires_authentication(anon):
    for method, url in [
        ("GET", "/api/bootstrap"),
        ("GET", "/api/pages/1"),
        ("POST", "/api/pages"),
        ("GET", "/api/search?q=x"),
        ("GET", "/api/files/" + "a" * 32),
        ("GET", "/api/trash"),
        ("GET", "/api/admin/users"),
        ("GET", "/api/pages/1/versions"),
    ]:
        response = anon.request(method, url, json={} if method == "POST" else None)
        assert response.status_code == 401, (method, url)


def test_app_shell_redirects_to_login(anon):
    response = anon.http.get("/p/5", follow_redirects=False)
    assert response.status_code == 303
    assert response.headers["location"] == "/login?next=/p/5"


def test_logout_invalidates_the_session(alice):
    assert alice.post("/api/auth/logout").status_code == 200
    assert alice.get("/api/bootstrap").status_code == 401


def test_stolen_cookie_is_useless_after_logout(alice, anon):
    name = get_settings().session_cookie_name
    token = alice.http.cookies.get(name)
    alice.post("/api/auth/logout")
    anon.http.cookies.set(name, token)
    assert anon.get("/api/bootstrap").status_code == 401


def test_session_expires_after_idle_timeout(alice):
    idle = get_settings().session_idle_minutes
    with session_scope() as db:
        db.execute(update(UserSession).values(last_seen_at=utcnow() - timedelta(minutes=idle + 1)))
    assert alice.get("/api/bootstrap").status_code == 401


def test_session_expires_at_absolute_lifetime(alice):
    with session_scope() as db:
        db.execute(update(UserSession).values(expires_at=utcnow() - timedelta(seconds=1)))
    assert alice.get("/api/bootstrap").status_code == 401


def test_activity_extends_the_session(alice):
    stale = utcnow() - timedelta(hours=2)
    with session_scope() as db:
        db.execute(update(UserSession).values(last_seen_at=stale))
    assert alice.get("/api/bootstrap").status_code == 200
    with session_scope() as db:
        last_seen = db.execute(select(UserSession.last_seen_at)).scalar_one()
    assert last_seen > stale + timedelta(hours=1)


def test_csrf_token_required_for_state_changes(alice):
    workspace_id = alice.personal_workspace_id()
    payload = {"title": "x", "workspace_id": workspace_id}
    missing = alice.http.post("/api/pages", json=payload)
    wrong = alice.http.post("/api/pages", json=payload, headers={"X-CSRF-Token": "nope"})
    assert missing.status_code == wrong.status_code == 403
    assert alice.post("/api/pages", json=payload).status_code == 201


def test_cross_origin_requests_are_blocked(alice):
    response = alice.post(
        "/api/pages",
        json={"title": "x", "workspace_id": alice.personal_workspace_id()},
        headers={"Origin": "https://evil.example"},
    )
    assert response.status_code == 403
    same_origin = alice.post(
        "/api/pages",
        json={"title": "x", "workspace_id": alice.personal_workspace_id()},
        headers={"Origin": "http://testserver"},
    )
    assert same_origin.status_code == 201


def test_login_rate_limit(anon):
    make_user("alice")
    limit = get_settings().login_max_failures
    for _ in range(limit):
        assert anon.login("alice", "wrong").status_code == 401
    blocked = anon.login("alice")  # even the right password is refused now
    assert blocked.status_code == 429
    assert "retry-after" in blocked.headers
    with session_scope() as db:
        failures = db.execute(
            select(AuditEvent).where(AuditEvent.action == "auth.login_failed")
        ).all()
    assert len(failures) == limit


def test_successful_login_resets_failure_counter(anon):
    make_user("alice")
    limit = get_settings().login_max_failures
    for _ in range(limit - 1):
        anon.login("alice", "wrong")
    assert anon.login("alice").status_code == 200
    for _ in range(limit - 1):
        assert anon.login("alice", "wrong").status_code == 401
    assert anon.login("alice").status_code == 200


def test_deactivated_user_is_signed_out_and_cannot_log_in(admin, alice, anon):
    response = admin.patch(f"/api/admin/users/{alice.user_id}", json={"is_active": False})
    assert response.status_code == 200
    assert alice.get("/api/bootstrap").status_code == 401
    assert anon.login("alice").status_code == 401


def test_change_password_signs_out_other_sessions(alice, client_factory):
    other = client_factory()
    assert other.login("alice").status_code == 200

    wrong = alice.post(
        "/api/account/password",
        json={"current_password": "wrong", "new_password": "another long password"},
    )
    assert wrong.status_code == 403
    too_short = alice.post(
        "/api/account/password", json={"current_password": PASSWORD, "new_password": "short"}
    )
    assert too_short.status_code == 422

    ok = alice.post(
        "/api/account/password",
        json={"current_password": PASSWORD, "new_password": "another long password"},
    )
    assert ok.status_code == 200
    assert alice.get("/api/bootstrap").status_code == 200
    assert other.get("/api/bootstrap").status_code == 401
    assert client_factory().login("alice", "another long password").status_code == 200


def test_sessions_can_be_listed_and_revoked(alice, client_factory):
    other = client_factory()
    other.login("alice")
    sessions = alice.get("/api/account/sessions").json()
    assert len(sessions) == 2
    target = next(s for s in sessions if not s["current"])
    assert alice.delete(f"/api/account/sessions/{target['id']}").status_code == 200
    assert other.get("/api/bootstrap").status_code == 401


def test_registration_is_disabled_by_default(anon):
    assert anon.get("/api/auth/registration").json()["open"] is False
    response = anon.http.post(
        "/api/auth/register",
        json={"username": "mallory", "email": "m@example.com", "password": PASSWORD},
    )
    assert response.status_code == 403


def test_admin_can_open_registration(admin, anon):
    assert admin.put("/api/admin/settings", json={"allow_registration": True}).status_code == 200
    response = anon.http.post(
        "/api/auth/register",
        json={"username": "dave", "email": "dave@example.com", "password": PASSWORD},
    )
    assert response.status_code == 200
    assert response.json()["user"]["is_admin"] is False


def test_invitation_flow(admin, anon, client_factory):
    invite = admin.post("/api/admin/invites", json={"email": "eve@example.com"}).json()
    token = invite["token"]
    status = anon.get(f"/api/auth/registration?invite={token}").json()
    assert status == {"open": False, "invite_valid": True, "invite_email": "eve@example.com"}

    wrong_email = anon.http.post(
        "/api/auth/register",
        json={"username": "eve", "email": "x@example.com", "password": PASSWORD, "invite": token},
    )
    assert wrong_email.status_code == 422

    ok = anon.http.post(
        "/api/auth/register",
        json={"username": "eve", "email": "eve@example.com", "password": PASSWORD, "invite": token},
    )
    assert ok.status_code == 200

    reuse = client_factory().http.post(
        "/api/auth/register",
        json={
            "username": "eve2",
            "email": "eve@example.com",
            "password": PASSWORD,
            "invite": token,
        },
    )
    assert reuse.status_code == 403


def test_security_headers(alice):
    response = alice.http.get("/", follow_redirects=False)
    assert response.status_code == 200
    assert "script-src 'self'" in response.headers["content-security-policy"]
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "SAMEORIGIN"
    assert alice.get("/api/bootstrap").headers["cache-control"] == "no-store"
