from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import Any, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel, Field

SERVICE_VERSION = "0.1.0"


class Settings(BaseModel):
    """Runtime settings loaded from environment without exposing secret values."""

    environment: str = "development"
    api_token: str | None = None
    trial_days: int = 14
    offline_grace_days: int = 3
    openai_configured: bool = False
    anthropic_configured: bool = False


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Read process env once per app process so tests can reset it explicitly."""

    return Settings(
        environment=os.getenv("JARVIS_BACKEND_ENV", "development").lower(),
        api_token=os.getenv("JARVIS_BACKEND_API_TOKEN") or None,
        trial_days=_read_int_env("JARVIS_TRIAL_DAYS", 14),
        offline_grace_days=_read_int_env("JARVIS_OFFLINE_GRACE_DAYS", 3),
        openai_configured=bool(os.getenv("OPENAI_API_KEY")),
        anthropic_configured=bool(os.getenv("ANTHROPIC_API_KEY")),
    )


def _read_int_env(name: str, default: int) -> int:
    """Keep bad env values from crashing startup; callers still get sane defaults."""

    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    try:
        parsed = int(raw_value)
    except ValueError:
        return default
    return parsed if parsed >= 0 else default


def require_api_token(
    authorization: str | None = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> None:
    """
    Protect control-plane endpoints when a token is configured.

    Development can run tokenless for local tests. Production refuses protected
    traffic without a configured token so a public deployment cannot silently
    become an unauthenticated license server.
    """

    if not settings.api_token:
        if settings.environment == "production":
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Backend API token is not configured",
            )
        return

    expected = f"Bearer {settings.api_token}"
    if authorization != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid backend API token",
            headers={"WWW-Authenticate": "Bearer"},
        )


class HealthResponse(BaseModel):
    status: Literal["ok"]
    service: Literal["jarvis-backend"]
    version: str
    environment: str
    providers: dict[str, bool]


class DeviceRegisterRequest(BaseModel):
    device_id: str = Field(min_length=8, max_length=128)
    app_version: str | None = Field(default=None, max_length=64)
    platform: str = Field(default="macos", max_length=32)


class DeviceRegisterResponse(BaseModel):
    device_id: str
    registered_at: datetime
    license: "LicenseStatusResponse"


class LicenseStatusRequest(BaseModel):
    appVersion: str | None = Field(default=None, max_length=64)
    deviceId: str = Field(min_length=8, max_length=128)


class LicenseStatusResponse(BaseModel):
    state: Literal["trial_active", "trial_expired", "licensed", "expired", "unknown"]
    deviceId: str
    trialStartedAt: datetime
    trialEndsAt: datetime
    offlineGraceEndsAt: datetime
    managedServicesEnabled: bool


class ManagedUtilityRequest(BaseModel):
    appVersion: str | None = Field(default=None, max_length=64)
    deviceId: str | None = Field(default=None, min_length=8, max_length=128)
    input: dict[str, Any] = Field(default_factory=dict)


class ManagedUtilityUsage(BaseModel):
    units: int = 0
    limit: int | None = None
    remaining: int | None = None


class ManagedUtilityResult(BaseModel):
    utility: str
    providers: dict[str, bool]
    message: str
    payload: dict[str, Any] = Field(default_factory=dict)


class ManagedUtilityResponse(BaseModel):
    ok: Literal[True]
    result: ManagedUtilityResult
    usage: ManagedUtilityUsage | None = None


app = FastAPI(
    title="Jarvis Backend MVP",
    description="Minimal control-plane contract for Jarvis Consumer.",
    version=SERVICE_VERSION,
)


@app.get("/healthz", response_model=HealthResponse)
async def healthz(settings: Settings = Depends(get_settings)) -> HealthResponse:
    """Report liveness and provider presence without returning secret values."""

    return HealthResponse(
        status="ok",
        service="jarvis-backend",
        version=SERVICE_VERSION,
        environment=settings.environment,
        providers=_provider_presence(settings),
    )


@app.post(
    "/v1/device/register",
    response_model=DeviceRegisterResponse,
    dependencies=[Depends(require_api_token)],
)
async def register_device(
    request: DeviceRegisterRequest,
    settings: Settings = Depends(get_settings),
) -> DeviceRegisterResponse:
    """
    Return the activation contract the Mac app can cache.

    This MVP is stateless on purpose: it defines the wire shape before adding a
    database, billing provider, or account system. A later slice can replace the
    deterministic trial calculation with persisted license rows.
    """

    now = _utcnow()
    return DeviceRegisterResponse(
        device_id=request.device_id,
        registered_at=now,
        license=_build_trial_license(request.device_id, now, settings),
    )


@app.post(
    "/v1/license/status",
    response_model=LicenseStatusResponse,
    dependencies=[Depends(require_api_token)],
)
async def license_status(
    request: LicenseStatusRequest,
    settings: Settings = Depends(get_settings),
) -> LicenseStatusResponse:
    """Return current license state for a device using the MVP trial policy."""

    return _build_trial_license(request.deviceId, _utcnow(), settings)


@app.post(
    "/v1/managed/utilities/{utility}",
    response_model=ManagedUtilityResponse,
    dependencies=[Depends(require_api_token)],
)
async def managed_utility(
    utility: str,
    request: ManagedUtilityRequest,
    settings: Settings = Depends(get_settings),
) -> ManagedUtilityResponse:
    """
    Placeholder for future server-held provider-key operations.

    The response only exposes provider availability. Raw keys remain process
    env on the server, which is the core safety boundary this service exists to
    establish before real managed features are wired in.
    """

    return ManagedUtilityResponse(
        ok=True,
        result=ManagedUtilityResult(
            utility=utility,
            providers=_provider_presence(settings),
            message="Managed utility contract is available; provider keys are server-held.",
            payload={},
        ),
        usage=ManagedUtilityUsage(),
    )


def _build_trial_license(
    device_id: str,
    now: datetime,
    settings: Settings,
) -> LicenseStatusResponse:
    """Build the stateless MVP trial response from server policy settings."""

    trial_expires_at = now + timedelta(days=settings.trial_days)
    offline_grace_expires_at = trial_expires_at + timedelta(days=settings.offline_grace_days)
    managed_services_enabled = settings.openai_configured or settings.anthropic_configured

    return LicenseStatusResponse(
        state="trial_active",
        deviceId=device_id,
        trialStartedAt=now,
        trialEndsAt=trial_expires_at,
        offlineGraceEndsAt=offline_grace_expires_at,
        managedServicesEnabled=managed_services_enabled,
    )


def _provider_presence(settings: Settings) -> dict[str, bool]:
    """Expose key presence only; never return raw provider key material."""

    return {
        "openai": settings.openai_configured,
        "anthropic": settings.anthropic_configured,
    }


def _utcnow() -> datetime:
    """Use timezone-aware timestamps so app caches can compare safely."""

    return datetime.now(timezone.utc)
