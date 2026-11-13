"""Request bodies (Pydantic models)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)


class LoginIn(Body):
    identifier: str = Field(min_length=1, max_length=254)
    password: str = Field(min_length=1, max_length=1024)


class RegisterIn(Body):
    username: str = Field(max_length=64)
    email: str = Field(max_length=254)
    display_name: str = Field(default="", max_length=120)
    password: str = Field(max_length=1024)
    invite: str | None = Field(default=None, max_length=128)


class AccountUpdateIn(Body):
    display_name: str | None = Field(default=None, max_length=120)
    email: str | None = Field(default=None, max_length=254)


class PasswordChangeIn(Body):
    current_password: str = Field(max_length=1024)
    new_password: str = Field(max_length=1024)


class PageCreateIn(Body):
    workspace_id: int | None = None
    parent_id: int | None = None
    title: str = Field(default="", max_length=1000)
    icon: str | None = Field(default=None, max_length=32)
    content: dict[str, Any] | None = None


class PageMetaIn(Body):
    title: str | None = Field(default=None, max_length=1000)
    icon: str | None = Field(default=None, max_length=32)
    cover_attachment_id: str | None = Field(default=None, max_length=32)


class ContentSaveIn(Body):
    content: dict[str, Any]
    base_revision: int = Field(ge=0)
    force: bool = False


class PageMoveIn(Body):
    parent_id: int | None = None
    workspace_id: int | None = None
    before_id: int | None = None
    after_id: int | None = None


class VersionCreateIn(Body):
    description: str | None = Field(default=None, max_length=300)


class ShareIn(Body):
    role: Literal["viewer", "editor"]


class CaptureIn(Body):
    text: str = Field(min_length=1, max_length=20_000)


class WorkspaceIn(Body):
    name: str = Field(min_length=1, max_length=120)


class MemberIn(Body):
    role: Literal["viewer", "editor", "owner"]


class UserCreateIn(Body):
    username: str = Field(max_length=64)
    email: str = Field(max_length=254)
    display_name: str = Field(default="", max_length=120)
    password: str = Field(max_length=1024)
    is_admin: bool = False


class UserUpdateIn(Body):
    display_name: str | None = Field(default=None, max_length=120)
    email: str | None = Field(default=None, max_length=254)
    is_admin: bool | None = None
    is_active: bool | None = None


class PasswordResetIn(Body):
    password: str = Field(max_length=1024)


class InviteIn(Body):
    email: str | None = Field(default=None, max_length=254)
    is_admin: bool = False


class AppSettingsIn(Body):
    allow_registration: bool | None = None
