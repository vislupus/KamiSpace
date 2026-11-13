"""Domain errors raised by the service layer and mapped to HTTP responses."""

from __future__ import annotations

from typing import Any


class AppError(Exception):
    status_code = 400
    code = "bad_request"

    def __init__(self, message: str, *, extra: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.extra = extra or {}


class NotFound(AppError):
    status_code = 404
    code = "not_found"

    def __init__(self, message: str = "Not found") -> None:
        super().__init__(message)


class Forbidden(AppError):
    status_code = 403
    code = "forbidden"

    def __init__(self, message: str = "You do not have access to this resource") -> None:
        super().__init__(message)


class Unauthorized(AppError):
    status_code = 401
    code = "unauthorized"

    def __init__(self, message: str = "Authentication required") -> None:
        super().__init__(message)


class Conflict(AppError):
    status_code = 409
    code = "conflict"


class ValidationFailed(AppError):
    status_code = 422
    code = "invalid"


class TooManyRequests(AppError):
    status_code = 429
    code = "rate_limited"


class PayloadTooLarge(AppError):
    status_code = 413
    code = "too_large"
