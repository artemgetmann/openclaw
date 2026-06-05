from __future__ import annotations

import base64
import binascii
import hashlib
import logging
import os
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal, Protocol
from urllib.parse import quote

from fastapi import Depends, FastAPI, Header, HTTPException, status
import httpx
import psycopg2
from psycopg2.extras import RealDictCursor
from pydantic import BaseModel, Field

SERVICE_VERSION = "0.1.0"
FIRECRAWL_API_BASE_URL = "https://api.firecrawl.dev/v2"
GOOGLE_PLACES_TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"
BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search"
BRAVE_LLM_CONTEXT_URL = "https://api.search.brave.com/res/v1/llm/context"
GEMINI_GENERATE_CONTENT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"
GEMINI_IMAGE_GENERATION_MODEL = "gemini-3-pro-image-preview"
OPENAI_AUDIO_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions"
OPENAI_AUDIO_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe"
TELEGRAM_BOT_API_BASE_URL = "https://api.telegram.org"
MANAGED_UTILITY_TIMEOUT_SECONDS = 20.0
TELEGRAM_MANAGED_BOT_TIMEOUT_SECONDS = 20.0
TELEGRAM_MANAGED_SETUP_TTL_MINUTES = 15
MAX_GEMINI_IMAGE_PROMPT_CHARS = 4000
MAX_OPENAI_AUDIO_BASE64_CHARS = 28_000_000
SUPPORTED_GEMINI_IMAGE_RESOLUTIONS = {"1K", "2K", "4K"}
SUPPORTED_GEMINI_IMAGE_ASPECT_RATIOS = {
    "1:1",
    "2:3",
    "3:2",
    "3:4",
    "4:3",
    "4:5",
    "5:4",
    "9:16",
    "16:9",
    "21:9",
}

telegram_managed_logger = logging.getLogger("uvicorn.error")


class Settings(BaseModel):
    """Runtime settings loaded from environment without exposing secret values."""

    environment: str = "development"
    api_token: str | None = None
    trial_days: int = 14
    offline_grace_days: int = 3
    db_path: str = "data/jarvis-backend.sqlite3"
    neon_database_url: str | None = None
    openai_configured: bool = False
    openai_api_key: str | None = Field(default=None, repr=False)
    anthropic_configured: bool = False
    firecrawl_api_key: str | None = Field(default=None, repr=False)
    google_places_api_key: str | None = Field(default=None, repr=False)
    gemini_api_key: str | None = Field(default=None, repr=False)
    brave_api_key: str | None = Field(default=None, repr=False)
    telegram_manager_bot_token: str | None = Field(default=None, repr=False)
    telegram_manager_bot_username: str | None = None


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Read process env once per app process so tests can reset it explicitly."""

    return Settings(
        environment=os.getenv("JARVIS_BACKEND_ENV", "development").lower(),
        api_token=os.getenv("JARVIS_BACKEND_API_TOKEN") or None,
        trial_days=_read_int_env("JARVIS_TRIAL_DAYS", 14),
        offline_grace_days=_read_int_env("JARVIS_OFFLINE_GRACE_DAYS", 3),
        db_path=os.getenv("JARVIS_BACKEND_DB_PATH") or "data/jarvis-backend.sqlite3",
        neon_database_url=os.getenv("NEON_DATABASE_URL") or None,
        openai_configured=bool(os.getenv("OPENAI_API_KEY")),
        openai_api_key=os.getenv("OPENAI_API_KEY") or None,
        anthropic_configured=bool(os.getenv("ANTHROPIC_API_KEY")),
        firecrawl_api_key=os.getenv("FIRECRAWL_API_KEY") or None,
        google_places_api_key=os.getenv("GOOGLE_PLACES_API_KEY") or None,
        gemini_api_key=os.getenv("GEMINI_API_KEY") or None,
        brave_api_key=os.getenv("BRAVE_API_KEY") or None,
        telegram_manager_bot_token=os.getenv("TELEGRAM_MANAGER_BOT_TOKEN") or None,
        telegram_manager_bot_username=os.getenv("MANAGER_BOT_USERNAME") or None,
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


class AccountLoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    deviceId: str = Field(min_length=8, max_length=128)
    appVersion: str | None = Field(default=None, max_length=64)
    platform: str = Field(default="macos", max_length=32)


class AccountLoginResponse(BaseModel):
    accountId: str
    email: str
    accountAccessToken: str
    license: "LicenseStatusResponse"


class LicenseStatusRequest(BaseModel):
    accountAccessToken: str | None = Field(default=None, min_length=16, max_length=256)
    appVersion: str | None = Field(default=None, max_length=64)
    deviceId: str = Field(min_length=8, max_length=128)


class LicenseStatusResponse(BaseModel):
    state: Literal["trial_active", "trial_expired", "licensed", "expired", "unknown"]
    deviceId: str
    accountId: str | None = None
    trialStartedAt: datetime
    trialEndsAt: datetime
    offlineGraceEndsAt: datetime
    managedServicesEnabled: bool


class AdminLicenseUpdateRequest(BaseModel):
    state: Literal["trial_active", "licensed", "expired"]


class ManagedUtilityRequest(BaseModel):
    appVersion: str | None = Field(default=None, max_length=64)
    deviceId: str | None = Field(default=None, min_length=8, max_length=128)
    input: dict[str, Any] = Field(default_factory=dict)


class ManagedUtilityUsage(BaseModel):
    units: int = 0
    limit: int | None = None
    remaining: int | None = None


class ManagedUtilityResult(BaseModel):
    provider: str
    payload: dict[str, Any] = Field(default_factory=dict)


class ManagedUtilityResponse(BaseModel):
    ok: Literal[True]
    result: ManagedUtilityResult
    usage: ManagedUtilityUsage | None = None


class TelegramManagedStartRequest(BaseModel):
    deviceId: str | None = Field(default=None, min_length=8, max_length=128)
    appVersion: str | None = Field(default=None, max_length=64)
    accountAccessToken: str | None = Field(default=None, min_length=16, max_length=256)
    suggestedBotName: str | None = Field(default=None, min_length=1, max_length=64)
    suggestedBotUsername: str | None = Field(default=None, min_length=5, max_length=32)


class TelegramManagedStartResponse(BaseModel):
    setupId: str
    approvalUrl: str
    suggestedBotUsername: str
    expiresAt: datetime
    status: Literal["pending"]


class TelegramManagedStatusResponse(BaseModel):
    setupId: str
    expiresAt: datetime
    status: Literal["pending", "connected"]
    suggestedBotUsername: str
    botId: int | None = None
    botUsername: str | None = None
    managedChildBotToken: str | None = Field(default=None, repr=False)


class TelegramManagerWebhookDiagnostic(BaseModel):
    configured: bool
    pendingUpdateCount: int | None = None


class TelegramManagerUpdatesDiagnostic(BaseModel):
    skipped: bool = False
    reason: str | None = None
    updateCount: int = 0
    updateIds: list[int] = Field(default_factory=list)
    managedBotCount: int = 0
    managedBotUsernames: list[str] = Field(default_factory=list)


class TelegramManagerDiagnosticResponse(BaseModel):
    configured: Literal[True]
    managerBotUsernameConfigured: str
    getMeId: int | None = None
    getMeUsername: str | None = None
    canManageBots: bool | None = None
    webhook: TelegramManagerWebhookDiagnostic
    updates: TelegramManagerUpdatesDiagnostic


class TelegramManagedSetupSession(BaseModel):
    setup_id: str
    device_id: str | None = None
    app_version: str | None = None
    account_id: str | None = None
    suggested_bot_name: str
    suggested_bot_username: str
    approval_url: str
    expires_at: datetime
    status: Literal["pending", "connected"] = "pending"
    bot_id: int | None = None
    bot_username: str | None = None
    managed_child_bot_token: str | None = Field(default=None, repr=False)
    last_update_id: int | None = None


telegram_managed_setup_sessions: dict[str, TelegramManagedSetupSession] = {}


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
    "/v1/account/login",
    response_model=AccountLoginResponse,
    dependencies=[Depends(require_api_token)],
)
async def account_login(
    request: AccountLoginRequest,
    settings: Settings = Depends(get_settings),
) -> AccountLoginResponse:
    """
    Activate the beta trial for a real account identity and device.

    This is intentionally email-based for the first self-serve beta. It is not
    proof of inbox ownership; it creates the durable account/device/trial link
    that Google/OAuth or billing can harden later without changing the app's
    entitlement response shape.
    """

    email = _normalize_email(request.email)
    store = get_license_store(settings)
    created = store.create_account_for_activation(email=email)
    account = created.account
    record = store.register_or_get_device(
        device_id=request.deviceId,
        account_id=account.account_id,
        app_version=request.appVersion,
        platform=request.platform,
        settings=settings,
    )
    return AccountLoginResponse(
        accountId=account.account_id,
        email=account.email,
        accountAccessToken=created.account_access_token,
        license=_license_response(record, _utcnow(), settings),
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
    Register or refresh a device while keeping trial dates stable.

    Registration is idempotent [safe to repeat]. Reinstalling or relaunching the
    app must not silently restart the trial clock, so the first registration time
    is persisted and later calls only refresh device metadata.
    """

    store = get_license_store(settings)
    record = store.register_or_get_device(
        device_id=request.device_id,
        account_id=None,
        app_version=request.app_version,
        platform=request.platform,
        settings=settings,
    )
    return DeviceRegisterResponse(
        device_id=request.device_id,
        registered_at=record.registered_at,
        license=_license_response(record, _utcnow(), settings),
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
    """Return current license state for a device using persisted trial policy."""

    store = get_license_store(settings)
    account_id = _account_id_from_access_token(store, request.accountAccessToken)
    record = store.register_or_get_device(
        device_id=request.deviceId,
        account_id=account_id,
        app_version=request.appVersion,
        platform="macos",
        settings=settings,
    )
    return _license_response(record, _utcnow(), settings)


@app.post(
    "/v1/admin/devices/{device_id}/license",
    response_model=LicenseStatusResponse,
    dependencies=[Depends(require_api_token)],
)
async def admin_update_license(
    device_id: str,
    request: AdminLicenseUpdateRequest,
    settings: Settings = Depends(get_settings),
) -> LicenseStatusResponse:
    """
    Minimal manual support path for beta licenses.

    This is intentionally tiny: no account dashboard, no billing provider, and
    no provider secrets. The backend token protects it, and it lets support mark
    a device licensed or expired while the schema remains ready for richer
    account records later.
    """

    store = get_license_store(settings)
    record = store.register_or_get_device(
        device_id=device_id,
        account_id=None,
        app_version=None,
        platform="macos",
        settings=settings,
    )
    record = store.update_license_state(device_id=record.device_id, state=request.state)
    return _license_response(record, _utcnow(), settings)


@app.post(
    "/v1/telegram/managed/start",
    response_model=TelegramManagedStartResponse,
    dependencies=[Depends(require_api_token)],
)
async def telegram_managed_start(
    request: TelegramManagedStartRequest,
    settings: Settings = Depends(get_settings),
) -> TelegramManagedStartResponse:
    """
    Start a Telegram managed-bot setup handoff.

    The backend owns the manager bot secret and returns only Telegram's approval
    link. The child token is not available until the user approves the new bot
    in Telegram and the manager receives a managed_bot update.
    """

    _require_telegram_manager_config(settings)
    store = get_license_store(settings)
    account_id: str | None = None
    if request.accountAccessToken:
        account_id = _account_id_from_access_token(
            store,
            request.accountAccessToken,
        )

    suggested_bot_username = _telegram_suggested_bot_username(request.suggestedBotUsername)
    suggested_bot_name = (request.suggestedBotName or "Jarvis Assistant").strip()
    setup_id = f"tgms_{secrets.token_urlsafe(16)}"
    expires_at = _utcnow() + timedelta(minutes=TELEGRAM_MANAGED_SETUP_TTL_MINUTES)
    approval_url = _telegram_managed_approval_url(
        manager_username=settings.telegram_manager_bot_username or "",
        suggested_bot_username=suggested_bot_username,
        suggested_bot_name=suggested_bot_name,
    )
    session = TelegramManagedSetupSession(
        setup_id=setup_id,
        device_id=request.deviceId,
        app_version=request.appVersion,
        account_id=account_id,
        suggested_bot_name=suggested_bot_name,
        suggested_bot_username=suggested_bot_username,
        approval_url=approval_url,
        expires_at=expires_at,
    )
    store.save_telegram_managed_setup_session(session=session)
    telegram_managed_setup_sessions[setup_id] = session
    _prune_expired_telegram_managed_sessions(store)

    return TelegramManagedStartResponse(
        setupId=session.setup_id,
        approvalUrl=session.approval_url,
        suggestedBotUsername=session.suggested_bot_username,
        expiresAt=session.expires_at,
        status="pending",
    )


@app.get(
    "/v1/telegram/managed/status/{setup_id}",
    response_model=TelegramManagedStatusResponse,
    dependencies=[Depends(require_api_token)],
)
async def telegram_managed_status(
    setup_id: str,
    settings: Settings = Depends(get_settings),
) -> TelegramManagedStatusResponse:
    """
    Poll Telegram for a matching managed-bot approval and finalize setup.

    Setup state is stored through the license-store abstraction so local tests
    stay SQLite-simple while production survives Render restarts on Neon.
    """

    _require_telegram_manager_config(settings)
    store = get_license_store(settings)
    session = _telegram_managed_setup_session(store, setup_id)
    if session.status == "pending":
        await _refresh_telegram_managed_setup_session(session, settings)
        store.save_telegram_managed_setup_session(session=session)
        telegram_managed_setup_sessions[setup_id] = session

    return _telegram_managed_status_response(session)


@app.get(
    "/v1/telegram/managed/manager/status",
    response_model=TelegramManagerDiagnosticResponse,
    dependencies=[Depends(require_api_token)],
)
async def telegram_managed_manager_status(
    settings: Settings = Depends(get_settings),
) -> TelegramManagerDiagnosticResponse:
    """
    Report safe manager-bot diagnostics for the live managed-bot handoff.

    This endpoint exists for production RC proof only: it verifies the manager
    bot identity, Bot Management capability, webhook state, and visible
    managed_bot updates without exposing or consuming any bot token.
    """

    _require_telegram_manager_config(settings)
    return await _telegram_manager_diagnostic_status(settings)


@app.post(
    "/v1/managed/utilities/{utility}",
    response_model=ManagedUtilityResponse,
)
async def managed_utility(
    utility: str,
    request: ManagedUtilityRequest,
    authorization: str | None = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> ManagedUtilityResponse:
    """
    Execute the first server-managed utilities with provider keys held here.

    The app sends a small, provider-neutral input. This backend performs the
    provider call, redacts configured secrets from any echoed JSON, and returns
    the stable envelope the app already expects.
    """

    _require_managed_utility_access(authorization, settings)

    if utility == "firecrawl.search":
        return await _firecrawl_search(request.input, settings)
    if utility == "firecrawl.scrape":
        return await _firecrawl_scrape(request.input, settings)
    if utility == "google_places.search":
        return await _google_places_search(request.input, settings)
    if utility == "brave.search":
        return await _brave_search(request.input, settings)
    if utility == "gemini.image.generate":
        return await _gemini_image_generate(request.input, settings)
    if utility == "openai.audio.transcribe":
        return await _openai_audio_transcribe(request.input, settings)

    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"Unknown managed utility: {utility}",
    )


def _require_telegram_manager_config(settings: Settings) -> None:
    """Fail closed until Render has both manager-bot identity values configured."""

    if settings.telegram_manager_bot_token and settings.telegram_manager_bot_username:
        return
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="telegram managed bots provider is not configured",
    )


def _telegram_suggested_bot_username(suggested_username: str | None) -> str:
    """
    Normalize a Telegram bot username or generate a safe short default.

    Telegram enforces the final uniqueness/availability check during approval.
    We still validate basic shape here so the app does not show obviously broken
    links that fail before the user even reaches Telegram.
    """

    username = (suggested_username or f"jarvis_{secrets.token_hex(4)}_bot").strip().lstrip("@")
    if (
        len(username) < 5
        or len(username) > 32
        or not username.replace("_", "").isalnum()
        or not username.lower().endswith("bot")
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="suggestedBotUsername must be 5-32 letters, numbers, or underscores and end with bot",
        )
    return username


def _telegram_managed_approval_url(
    *,
    manager_username: str,
    suggested_bot_username: str,
    suggested_bot_name: str,
) -> str:
    """Build Telegram's managed-bot creation link without exposing the manager token."""

    clean_manager_username = manager_username.strip().lstrip("@")
    url = f"https://t.me/newbot/{clean_manager_username}/{suggested_bot_username}"
    if suggested_bot_name:
        url = f"{url}?name={quote(suggested_bot_name)}"
    return url


def _telegram_managed_setup_session(
    store: LicenseStore,
    setup_id: str,
) -> TelegramManagedSetupSession:
    """Fetch a non-expired setup session from durable storage by public setup id."""

    # Durable storage is authoritative. The process cache only prevents extra
    # row decoding inside one worker and must not hide restart/redeploy loss.
    session = store.get_telegram_managed_setup_session(setup_id=setup_id)
    if not session:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Telegram setup not found")
    if session.expires_at <= _utcnow():
        store.delete_telegram_managed_setup_session(setup_id=setup_id)
        telegram_managed_setup_sessions.pop(setup_id, None)
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="Telegram setup expired")
    telegram_managed_setup_sessions[setup_id] = session
    return session


def _prune_expired_telegram_managed_sessions(store: LicenseStore) -> None:
    """Keep durable setup state and the process cache from growing forever."""

    now = _utcnow()
    store.delete_expired_telegram_managed_setup_sessions(now=now)
    expired_setup_ids = [
        setup_id
        for setup_id, session in telegram_managed_setup_sessions.items()
        if session.expires_at <= now
    ]
    for setup_id in expired_setup_ids:
        telegram_managed_setup_sessions.pop(setup_id, None)


async def _refresh_telegram_managed_setup_session(
    session: TelegramManagedSetupSession,
    settings: Settings,
) -> None:
    """
    Poll for the matching managed_bot update, then fetch and restrict the child.

    The child token is returned to the caller but never logged and never echoed
    in provider error payloads because Telegram provider responses are sanitized
    against both manager and child secrets.
    """

    previous_last_update_id = session.last_update_id
    telegram_managed_logger.info(
        "telegram managed setup poll started setup_id=%s suggested_bot_username=%s last_update_id=%s",
        session.setup_id,
        session.suggested_bot_username,
        previous_last_update_id,
    )
    updates = await _telegram_bot_api_call(
        method="getUpdates",
        token=settings.telegram_manager_bot_token or "",
        payload=_telegram_managed_get_updates_payload(session),
        settings=settings,
    )
    if not isinstance(updates, list):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="telegram getUpdates returned an invalid result",
        )

    update_summary = _telegram_managed_update_summary(updates)
    telegram_managed_logger.info(
        "telegram managed setup poll result setup_id=%s update_count=%d update_ids=%s managed_bot_count=%d managed_bot_usernames=%s",
        session.setup_id,
        len(updates),
        update_summary["update_ids"],
        len(update_summary["managed_bot_usernames"]),
        update_summary["managed_bot_usernames"],
    )

    managed_bot = _matching_managed_bot_update(session, updates)
    if managed_bot is None:
        telegram_managed_logger.info(
            "telegram managed setup still pending setup_id=%s suggested_bot_username=%s previous_last_update_id=%s last_update_id=%s ignored_managed_bot_usernames=%s",
            session.setup_id,
            session.suggested_bot_username,
            previous_last_update_id,
            session.last_update_id,
            update_summary["managed_bot_usernames"],
        )
        return

    telegram_managed_logger.info(
        "telegram managed setup matched bot setup_id=%s suggested_bot_username=%s bot_id=%s bot_username=%s",
        session.setup_id,
        session.suggested_bot_username,
        managed_bot["id"],
        managed_bot["username"],
    )
    child_token_payload = await _telegram_bot_api_call(
        method="getManagedBotToken",
        token=settings.telegram_manager_bot_token or "",
        payload={"user_id": managed_bot["id"]},
        settings=settings,
    )
    if not isinstance(child_token_payload, str) or not child_token_payload:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="telegram getManagedBotToken returned an invalid result",
        )

    child_get_me = await _telegram_bot_api_call(
        method="getMe",
        token=child_token_payload,
        payload={},
        settings=settings,
        extra_secrets=[child_token_payload],
    )
    if not isinstance(child_get_me, dict):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="telegram child getMe returned an invalid result",
        )

    await _telegram_bot_api_call(
        method="setManagedBotAccessSettings",
        token=settings.telegram_manager_bot_token or "",
        payload={"user_id": managed_bot["id"], "is_access_restricted": True},
        settings=settings,
        extra_secrets=[child_token_payload],
    )

    # Prefer getMe as the final truth because it validates the fetched token.
    session.status = "connected"
    session.bot_id = _telegram_int_field(child_get_me, "id") or managed_bot["id"]
    session.bot_username = _telegram_string_field(child_get_me, "username") or managed_bot["username"]
    session.managed_child_bot_token = child_token_payload
    telegram_managed_logger.info(
        "telegram managed setup connected setup_id=%s bot_id=%s bot_username=%s",
        session.setup_id,
        session.bot_id,
        session.bot_username,
    )


def _telegram_managed_get_updates_payload(session: TelegramManagedSetupSession) -> dict[str, Any]:
    """Build a narrow getUpdates request that only asks Telegram for managed-bot events."""

    payload: dict[str, Any] = {
        "limit": 20,
        "timeout": 0,
        "allowed_updates": ["managed_bot"],
    }
    if session.last_update_id is not None:
        payload["offset"] = session.last_update_id + 1
    return payload


async def _telegram_manager_diagnostic_status(
    settings: Settings,
) -> TelegramManagerDiagnosticResponse:
    """Fetch non-secret manager-bot health facts from Telegram for live RC triage."""

    manager_get_me = await _telegram_bot_api_call(
        method="getMe",
        token=settings.telegram_manager_bot_token or "",
        payload={},
        settings=settings,
    )
    if not isinstance(manager_get_me, dict):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="telegram manager getMe returned an invalid result",
        )

    webhook_info = await _telegram_bot_api_call(
        method="getWebhookInfo",
        token=settings.telegram_manager_bot_token or "",
        payload={},
        settings=settings,
    )
    if not isinstance(webhook_info, dict):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="telegram manager getWebhookInfo returned an invalid result",
        )

    webhook_url = _telegram_string_field(webhook_info, "url")
    webhook = TelegramManagerWebhookDiagnostic(
        configured=webhook_url is not None,
        pendingUpdateCount=_telegram_int_field(webhook_info, "pending_update_count"),
    )
    updates = TelegramManagerUpdatesDiagnostic(skipped=True, reason="webhook_configured")

    # getUpdates cannot be used while a webhook is configured. When there is no
    # webhook, this no-offset poll is read-only for our purposes because it does
    # not acknowledge or advance Telegram's update cursor.
    if webhook_url is None:
        update_payload = await _telegram_bot_api_call(
            method="getUpdates",
            token=settings.telegram_manager_bot_token or "",
            payload={
                "limit": 20,
                "timeout": 0,
                "allowed_updates": ["managed_bot"],
            },
            settings=settings,
        )
        if not isinstance(update_payload, list):
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="telegram manager getUpdates returned an invalid result",
            )
        update_summary = _telegram_managed_update_summary(update_payload)
        updates = TelegramManagerUpdatesDiagnostic(
            skipped=False,
            updateCount=len(update_payload),
            updateIds=update_summary["update_ids"],
            managedBotCount=len(update_summary["managed_bot_usernames"]),
            managedBotUsernames=update_summary["managed_bot_usernames"],
        )

    can_manage_bots = manager_get_me.get("can_manage_bots")
    return TelegramManagerDiagnosticResponse(
        configured=True,
        managerBotUsernameConfigured=(settings.telegram_manager_bot_username or "").strip().lstrip("@"),
        getMeId=_telegram_int_field(manager_get_me, "id"),
        getMeUsername=_telegram_string_field(manager_get_me, "username"),
        canManageBots=can_manage_bots if isinstance(can_manage_bots, bool) else None,
        webhook=webhook,
        updates=updates,
    )


def _matching_managed_bot_update(
    session: TelegramManagedSetupSession,
    updates: list[Any],
) -> dict[str, Any] | None:
    """Find the update for this suggested username and advance this session's offset."""

    expected_username = session.suggested_bot_username.lower()
    for update in updates:
        if not isinstance(update, dict):
            continue
        update_id = update.get("update_id")
        if isinstance(update_id, int) and not isinstance(update_id, bool):
            session.last_update_id = update_id
        managed_bot_update = update.get("managed_bot")
        if not isinstance(managed_bot_update, dict):
            continue
        bot = managed_bot_update.get("bot")
        if not isinstance(bot, dict):
            continue
        bot_id = _telegram_int_field(bot, "id")
        username = _telegram_string_field(bot, "username")
        if bot_id is None or username is None:
            continue
        if username.lower() == expected_username:
            return {"id": bot_id, "username": username}
    return None


def _telegram_managed_update_summary(updates: list[Any]) -> dict[str, list[Any]]:
    """Return non-secret metadata about Telegram managed-bot updates for logs."""

    update_ids: list[int] = []
    managed_bot_usernames: list[str] = []
    for update in updates:
        if not isinstance(update, dict):
            continue
        update_id = update.get("update_id")
        if isinstance(update_id, int) and not isinstance(update_id, bool):
            update_ids.append(update_id)
        managed_bot_update = update.get("managed_bot")
        if not isinstance(managed_bot_update, dict):
            continue
        bot = managed_bot_update.get("bot")
        if not isinstance(bot, dict):
            continue
        username = _telegram_string_field(bot, "username")
        if username:
            managed_bot_usernames.append(username)
    return {"update_ids": update_ids, "managed_bot_usernames": managed_bot_usernames}


async def _telegram_bot_api_call(
    *,
    method: str,
    token: str,
    payload: dict[str, Any],
    settings: Settings,
    extra_secrets: list[str] | None = None,
) -> Any:
    """Call Telegram Bot API and sanitize failures before they cross our boundary."""

    try:
        async with httpx.AsyncClient(timeout=TELEGRAM_MANAGED_BOT_TIMEOUT_SECONDS) as client:
            response = await client.post(
                f"{TELEGRAM_BOT_API_BASE_URL}/bot{token}/{method}",
                json=payload,
            )
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="telegram request timed out",
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="telegram request failed",
        ) from exc

    provider_payload = _response_json_or_text(response)
    sanitized_payload = _sanitize_provider_payload(
        provider_payload,
        settings,
        extra_secrets=extra_secrets,
    )
    if response.status_code >= 400 or not isinstance(provider_payload, dict) or not provider_payload.get("ok"):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={
                "provider": "telegram",
                "method": method,
                "status": response.status_code,
                "payload": sanitized_payload,
            },
        )
    return provider_payload.get("result")


def _telegram_int_field(payload: dict[str, Any], field_name: str) -> int | None:
    """Read Telegram integer fields without accepting bools as ids."""

    value = payload.get(field_name)
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    return None


def _telegram_string_field(payload: dict[str, Any], field_name: str) -> str | None:
    """Read Telegram string fields and collapse empty values to None."""

    value = payload.get(field_name)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _telegram_managed_status_response(
    session: TelegramManagedSetupSession,
) -> TelegramManagedStatusResponse:
    """Convert the internal session model to the app-facing status contract."""

    return TelegramManagedStatusResponse(
        setupId=session.setup_id,
        expiresAt=session.expires_at,
        status=session.status,
        suggestedBotUsername=session.suggested_bot_username,
        botId=session.bot_id,
        botUsername=session.bot_username,
        managedChildBotToken=session.managed_child_bot_token,
    )


async def _firecrawl_search(
    input_payload: dict[str, Any],
    settings: Settings,
) -> ManagedUtilityResponse:
    """Run a conservative Firecrawl web search using the server-held API key."""

    api_key = _require_provider_key("firecrawl", settings.firecrawl_api_key)
    query = _required_input_string(input_payload, "query", "firecrawl.search")
    limit = _optional_limit(input_payload, default=5, maximum=10, utility="firecrawl.search")
    provider_payload = await _post_provider_json(
        provider="firecrawl",
        url=f"{FIRECRAWL_API_BASE_URL}/search",
        headers={"Authorization": f"Bearer {api_key}"},
        json_payload={"query": query, "limit": limit},
        settings=settings,
    )
    return _managed_provider_response("firecrawl", provider_payload)


async def _firecrawl_scrape(
    input_payload: dict[str, Any],
    settings: Settings,
) -> ManagedUtilityResponse:
    """Scrape one URL through Firecrawl and request markdown by default."""

    api_key = _require_provider_key("firecrawl", settings.firecrawl_api_key)
    url = _required_input_string(input_payload, "url", "firecrawl.scrape")
    provider_payload = await _post_provider_json(
        provider="firecrawl",
        url=f"{FIRECRAWL_API_BASE_URL}/scrape",
        headers={"Authorization": f"Bearer {api_key}"},
        json_payload={"url": url, "formats": ["markdown"]},
        settings=settings,
    )
    return _managed_provider_response("firecrawl", provider_payload)


async def _google_places_search(
    input_payload: dict[str, Any],
    settings: Settings,
) -> ManagedUtilityResponse:
    """Run Google Places Text Search with a tight field mask to control payload size."""

    api_key = _require_provider_key("google_places", settings.google_places_api_key)
    query = _required_input_string(input_payload, "query", "google_places.search")
    limit = _optional_limit(input_payload, default=5, maximum=10, utility="google_places.search")
    provider_payload = await _post_provider_json(
        provider="google_places",
        url=GOOGLE_PLACES_TEXT_SEARCH_URL,
        headers={
            "X-Goog-Api-Key": api_key,
            "X-Goog-FieldMask": (
                "places.id,places.displayName,places.formattedAddress,"
                "places.location,places.googleMapsUri,nextPageToken"
            ),
        },
        json_payload={"textQuery": query, "pageSize": limit},
        settings=settings,
    )
    return _managed_provider_response("google_places", provider_payload)


async def _brave_search(
    input_payload: dict[str, Any],
    settings: Settings,
) -> ManagedUtilityResponse:
    """Run Brave Search with the server-held key so managed users stay BYOK-free."""

    api_key = _require_provider_key("brave", settings.brave_api_key)
    query = _required_input_string(input_payload, "query", "brave.search")
    count = _optional_count_or_limit(input_payload, default=5, maximum=10, utility="brave.search")
    mode = _optional_string(input_payload, "mode")
    if mode not in (None, "web", "llm-context"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="brave.search input.mode must be web or llm-context",
        )

    query_params = {"q": query}
    if mode != "llm-context":
        query_params["count"] = str(count)
    for field_name in ("country", "search_lang", "ui_lang", "freshness"):
        value = _optional_string(input_payload, field_name)
        if value:
            query_params[field_name] = value

    provider_payload = await _get_provider_json(
        provider="brave",
        url=BRAVE_LLM_CONTEXT_URL if mode == "llm-context" else BRAVE_SEARCH_URL,
        headers={"X-Subscription-Token": api_key, "Accept": "application/json"},
        params=query_params,
        settings=settings,
    )
    return _managed_provider_response("brave", provider_payload)


async def _gemini_image_generate(
    input_payload: dict[str, Any],
    settings: Settings,
) -> ManagedUtilityResponse:
    """Generate one image through Gemini with the server-held API key.

    This first managed slice intentionally supports text-to-image only. Image
    editing/composition requires client-to-server binary upload limits, storage,
    and abuse controls, so the local BYOK Nano Banana path remains responsible
    for input-image workflows until that contract is designed.
    """

    api_key = _require_provider_key("gemini", settings.gemini_api_key)
    prompt = _required_input_string(input_payload, "prompt", "gemini.image.generate")
    if len(prompt) > MAX_GEMINI_IMAGE_PROMPT_CHARS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "gemini.image.generate input.prompt must be "
                f"{MAX_GEMINI_IMAGE_PROMPT_CHARS} characters or fewer"
            ),
        )

    resolution = _optional_choice(
        input_payload,
        "resolution",
        "gemini.image.generate",
        SUPPORTED_GEMINI_IMAGE_RESOLUTIONS,
        default="1K",
    )
    aspect_ratio = _optional_choice(
        input_payload,
        "aspectRatio",
        "gemini.image.generate",
        SUPPORTED_GEMINI_IMAGE_ASPECT_RATIOS,
    )
    provider_payload = await _post_provider_json(
        provider="gemini",
        url=f"{GEMINI_GENERATE_CONTENT_BASE_URL}/{GEMINI_IMAGE_GENERATION_MODEL}:generateContent",
        headers={"x-goog-api-key": api_key},
        json_payload=_gemini_image_generation_request(
            prompt=prompt,
            resolution=resolution,
            aspect_ratio=aspect_ratio,
        ),
        settings=settings,
    )
    return _managed_provider_response(
        "gemini",
        _extract_gemini_image_generation_payload(
            provider_payload=provider_payload,
            model=GEMINI_IMAGE_GENERATION_MODEL,
        ),
    )


async def _post_provider_json(
    *,
    provider: str,
    url: str,
    headers: dict[str, str],
    json_payload: dict[str, Any],
    settings: Settings,
) -> dict[str, Any]:
    """POST provider JSON while converting network failures into clean API errors."""

    try:
        async with httpx.AsyncClient(timeout=MANAGED_UTILITY_TIMEOUT_SECONDS) as client:
            response = await client.post(url, headers=headers, json=json_payload)
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail=f"{provider} request timed out",
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"{provider} request failed",
        ) from exc

    provider_payload = _response_json_or_text(response)
    sanitized_payload = _sanitize_provider_payload(provider_payload, settings)
    if response.status_code >= 400:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={
                "provider": provider,
                "status": response.status_code,
                "payload": sanitized_payload,
            },
        )

    if isinstance(sanitized_payload, dict):
        return sanitized_payload
    return {"value": sanitized_payload}


async def _get_provider_json(
    *,
    provider: str,
    url: str,
    headers: dict[str, str],
    params: dict[str, str],
    settings: Settings,
) -> dict[str, Any]:
    """GET provider JSON for read-only managed utilities such as Brave Search."""

    try:
        async with httpx.AsyncClient(timeout=MANAGED_UTILITY_TIMEOUT_SECONDS) as client:
            response = await client.get(url, headers=headers, params=params)
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail=f"{provider} request timed out",
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"{provider} request failed",
        ) from exc

    provider_payload = _response_json_or_text(response)
    sanitized_payload = _sanitize_provider_payload(provider_payload, settings)
    if response.status_code >= 400:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={
                "provider": provider,
                "status": response.status_code,
                "payload": sanitized_payload,
            },
        )

    if isinstance(sanitized_payload, dict):
        return sanitized_payload
    return {"value": sanitized_payload}


def _response_json_or_text(response: httpx.Response) -> Any:
    """Keep provider pass-through JSON-first, with text fallback for bad responses."""

    try:
        return response.json()
    except ValueError:
        return {"text": response.text}


def _require_provider_key(provider: str, api_key: str | None) -> str:
    """Fail closed when Render has not been configured for this managed utility."""

    if api_key:
        return api_key
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=f"{provider} provider is not configured",
    )


def _required_input_string(input_payload: dict[str, Any], field_name: str, utility: str) -> str:
    """Validate the tiny public utility contract before spending provider quota."""

    raw_value = input_payload.get(field_name)
    if not isinstance(raw_value, str) or not raw_value.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{utility} requires input.{field_name}",
        )
    return raw_value.strip()


def _optional_string(input_payload: dict[str, Any], field_name: str) -> str | None:
    """Allow only non-empty string provider parameters through the managed boundary."""

    raw_value = input_payload.get(field_name)
    if not isinstance(raw_value, str):
        return None
    value = raw_value.strip()
    return value or None


def _optional_choice(
    input_payload: dict[str, Any],
    field_name: str,
    utility: str,
    choices: set[str],
    *,
    default: str | None = None,
) -> str | None:
    """Validate small enum-like fields before a provider call can spend money."""

    raw_value = input_payload.get(field_name)
    if raw_value is None:
        return default
    if not isinstance(raw_value, str) or raw_value not in choices:
        allowed = ", ".join(sorted(choices))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{utility} input.{field_name} must be one of: {allowed}",
        )
    return raw_value


def _optional_limit(
    input_payload: dict[str, Any],
    *,
    default: int,
    maximum: int,
    utility: str,
) -> int:
    """Read a small positive limit so managed calls stay bounded by default."""

    raw_value = input_payload.get("limit")
    if raw_value is None:
        return default
    if (
        isinstance(raw_value, bool)
        or not isinstance(raw_value, int)
        or raw_value < 1
        or raw_value > maximum
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{utility} input.limit must be an integer between 1 and {maximum}",
        )
    return raw_value


def _required_base64_audio(input_payload: dict[str, Any], utility: str) -> bytes:
    """Decode one bounded audio payload before opening the provider spend path."""

    raw_value = _required_input_string(input_payload, "fileBase64", utility)
    if len(raw_value) > MAX_OPENAI_AUDIO_BASE64_CHARS:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"{utility} input.fileBase64 is too large",
        )
    try:
        return base64.b64decode(raw_value, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{utility} input.fileBase64 must be valid base64",
        ) from None


def _optional_openai_audio_model(input_payload: dict[str, Any]) -> str:
    """Keep the launch path narrow while allowing the app's default STT model."""

    model = _optional_string(input_payload, "model")
    if model and model != OPENAI_AUDIO_TRANSCRIPTION_MODEL:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"openai.audio.transcribe input.model must be {OPENAI_AUDIO_TRANSCRIPTION_MODEL}",
        )
    return model or OPENAI_AUDIO_TRANSCRIPTION_MODEL


def _openai_audio_filename(input_payload: dict[str, Any], mime_type: str | None) -> str:
    """Give OpenAI a stable filename without trusting caller-supplied paths."""

    raw_name = _optional_string(input_payload, "fileName")
    if raw_name:
        name = Path(raw_name).name.strip()
        if name:
            return name[:128]
    if mime_type == "audio/ogg":
        return "voice.ogg"
    if mime_type == "audio/mpeg":
        return "voice.mp3"
    if mime_type == "audio/mp4":
        return "voice.m4a"
    return "voice.wav"


async def _openai_audio_transcribe(
    input_payload: dict[str, Any],
    settings: Settings,
) -> ManagedUtilityResponse:
    """Transcribe managed-user voice notes with the backend-held OpenAI key."""

    utility = "openai.audio.transcribe"
    api_key = _require_provider_key("openai", settings.openai_api_key)
    audio_bytes = _required_base64_audio(input_payload, utility)
    model = _optional_openai_audio_model(input_payload)
    mime_type = _optional_string(input_payload, "mimeType") or "application/octet-stream"
    file_name = _openai_audio_filename(input_payload, mime_type)

    files = {
        "file": (file_name, audio_bytes, mime_type),
    }
    data: dict[str, str] = {"model": model}
    language = _optional_string(input_payload, "language")
    if language:
        data["language"] = language
    prompt = _optional_string(input_payload, "prompt")
    if prompt:
        data["prompt"] = prompt

    try:
        async with httpx.AsyncClient(timeout=MANAGED_UTILITY_TIMEOUT_SECONDS) as client:
            response = await client.post(
                OPENAI_AUDIO_TRANSCRIPTION_URL,
                headers={"Authorization": f"Bearer {api_key}"},
                data=data,
                files=files,
            )
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="openai request timed out",
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="openai request failed",
        ) from exc

    payload = _response_json_or_text(response)
    sanitized_payload = _sanitize_provider_payload(payload, settings, extra_secrets=[api_key])
    if response.status_code >= 400:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={
                "provider": "openai",
                "status": response.status_code,
                "payload": sanitized_payload,
            },
        )
    text = sanitized_payload.get("text") if isinstance(sanitized_payload, dict) else None
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="openai returned no transcription text",
        )
    return _managed_provider_response(
        "openai",
        {
            "text": text.strip(),
            "model": model,
        },
    )


def _optional_count_or_limit(
    input_payload: dict[str, Any],
    *,
    default: int,
    maximum: int,
    utility: str,
) -> int:
    """Support both app-facing count and existing managed utility limit names."""

    raw_count = input_payload.get("count")
    if raw_count is None:
        return _optional_limit(input_payload, default=default, maximum=maximum, utility=utility)
    if input_payload.get("limit") is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{utility} input.count and input.limit cannot both be set",
        )
    return _optional_limit(
        {"limit": raw_count},
        default=default,
        maximum=maximum,
        utility=utility,
    )


def _gemini_image_generation_request(
    *,
    prompt: str,
    resolution: str | None,
    aspect_ratio: str | None,
) -> dict[str, Any]:
    """Build the narrow Gemini REST payload for one text-to-image request."""

    image_config: dict[str, str] = {}
    if resolution:
        image_config["imageSize"] = resolution
    if aspect_ratio:
        image_config["aspectRatio"] = aspect_ratio

    generation_config: dict[str, Any] = {
        "responseModalities": ["TEXT", "IMAGE"],
    }
    if image_config:
        generation_config["imageConfig"] = image_config

    return {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": generation_config,
    }


def _extract_gemini_image_generation_payload(
    *,
    provider_payload: dict[str, Any],
    model: str,
) -> dict[str, Any]:
    """Normalize Gemini's candidate/parts response into a tiny app contract."""

    images: list[dict[str, str]] = []
    texts: list[str] = []
    candidates = provider_payload.get("candidates")
    if isinstance(candidates, list):
        for candidate in candidates:
            if not isinstance(candidate, dict):
                continue
            content = candidate.get("content")
            if not isinstance(content, dict):
                continue
            parts = content.get("parts")
            if not isinstance(parts, list):
                continue
            for part in parts:
                if not isinstance(part, dict):
                    continue
                text = part.get("text")
                if isinstance(text, str) and text.strip():
                    texts.append(text)
                inline_data = part.get("inlineData") or part.get("inline_data")
                if not isinstance(inline_data, dict):
                    continue
                data = inline_data.get("data")
                if not isinstance(data, str) or not data.strip():
                    continue
                mime_type = inline_data.get("mimeType") or inline_data.get("mime_type")
                images.append(
                    {
                        "mimeType": mime_type if isinstance(mime_type, str) else "image/png",
                        "data": data,
                    }
                )

    if not images:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="gemini returned no generated image",
        )

    model_version = provider_payload.get("modelVersion")
    payload: dict[str, Any] = {
        "model": model_version if isinstance(model_version, str) and model_version else model,
        "images": images,
    }
    if texts:
        payload["text"] = "\n".join(texts)
    usage_metadata = provider_payload.get("usageMetadata")
    if isinstance(usage_metadata, dict):
        payload["usageMetadata"] = usage_metadata
    return payload


def _managed_provider_response(
    provider: str,
    provider_payload: dict[str, Any],
) -> ManagedUtilityResponse:
    """Wrap provider JSON in the app-facing envelope without leaking keys."""

    return ManagedUtilityResponse(
        ok=True,
        result=ManagedUtilityResult(
            provider=provider,
            payload=provider_payload,
        ),
        usage=ManagedUtilityUsage(units=_provider_units(provider_payload)),
    )


def _provider_units(provider_payload: dict[str, Any]) -> int:
    """Expose coarse usage when the provider returns it, otherwise count one call."""

    credits_used = provider_payload.get("creditsUsed")
    if isinstance(credits_used, int) and not isinstance(credits_used, bool) and credits_used >= 0:
        return credits_used
    return 1


def _sanitize_provider_payload(
    payload: Any,
    settings: Settings,
    *,
    extra_secrets: list[str] | None = None,
) -> Any:
    """Recursively redact known server secrets if a provider ever echoes them."""

    secrets_to_redact = [
        value
        for value in (
            settings.api_token,
            settings.openai_api_key,
            settings.firecrawl_api_key,
            settings.google_places_api_key,
            settings.gemini_api_key,
            settings.brave_api_key,
            settings.telegram_manager_bot_token,
        )
        if value
    ]
    if extra_secrets:
        secrets_to_redact.extend(secret_value for secret_value in extra_secrets if secret_value)
    return _redact_known_secrets(payload, secrets_to_redact)


def _redact_known_secrets(payload: Any, secrets_to_redact: list[str]) -> Any:
    """Replace exact configured secret substrings while preserving provider shape."""

    if isinstance(payload, dict):
        return {
            key: _redact_known_secrets(value, secrets_to_redact)
            for key, value in payload.items()
        }
    if isinstance(payload, list):
        return [_redact_known_secrets(value, secrets_to_redact) for value in payload]
    if isinstance(payload, str):
        redacted_value = payload
        for secret_value in secrets_to_redact:
            redacted_value = redacted_value.replace(secret_value, "[redacted]")
        return redacted_value
    return payload


class LicenseRecord(BaseModel):
    """Persistent device/license row normalized into typed Python values."""

    device_id: str
    account_id: str | None = None
    app_version: str | None = None
    platform: str
    registered_at: datetime
    trial_started_at: datetime
    trial_ends_at: datetime
    offline_grace_ends_at: datetime
    license_state: Literal["trial_active", "licensed", "expired"]


class AccountRecord(BaseModel):
    """Persistent beta account row used to attach devices to a trial owner."""

    account_id: str
    email: str
    created_at: datetime


class CreatedAccountRecord(BaseModel):
    """Account creation result that includes the one-time raw bearer token."""

    account: AccountRecord
    account_access_token: str


class LicenseStore(Protocol):
    """Persistence contract shared by local SQLite and production Neon stores."""

    def register_or_get_device(
        self,
        *,
        device_id: str,
        account_id: str | None,
        app_version: str | None,
        platform: str,
        settings: Settings,
    ) -> LicenseRecord:
        """Create or refresh a device row without resetting its trial clock."""

    def create_account_for_activation(self, *, email: str) -> CreatedAccountRecord:
        """Create a new beta account and return the raw token exactly once."""

    def get_account_by_access_token(self, *, account_access_token: str) -> AccountRecord | None:
        """Resolve a previously issued account token without exposing secrets."""

    def get_device_license_by_account_id(self, *, account_id: str) -> LicenseRecord | None:
        """Resolve the newest device license linked to one account."""

    def update_license_state(
        self,
        *,
        device_id: str,
        state: Literal["trial_active", "licensed", "expired"],
    ) -> LicenseRecord:
        """Persist a manual license override for the requested device."""

    def save_telegram_managed_setup_session(
        self,
        *,
        session: TelegramManagedSetupSession,
    ) -> None:
        """Persist the Telegram setup session without storing the manager token."""

    def get_telegram_managed_setup_session(
        self,
        *,
        setup_id: str,
    ) -> TelegramManagedSetupSession | None:
        """Load one Telegram setup session by public setup id."""

    def delete_telegram_managed_setup_session(self, *, setup_id: str) -> None:
        """Delete one Telegram setup session after expiry or cleanup."""

    def delete_expired_telegram_managed_setup_sessions(self, *, now: datetime) -> None:
        """Delete Telegram setup sessions whose approval window has expired."""


def get_license_store(settings: Settings) -> LicenseStore:
    """
    Select the only persistence backend allowed for the current environment.

    Production must use Neon/Postgres because Render instance filesystems are
    ephemeral [lost on restart/redeploy]. SQLite stays available for local dev
    and tests so contributors do not need a live Neon database to run contracts.
    """

    if settings.neon_database_url:
        return PostgresLicenseStore(settings.neon_database_url)

    if settings.environment == "production":
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="NEON_DATABASE_URL is required for production persistence",
        )

    return SQLiteLicenseStore(settings.db_path)


class SQLiteLicenseStore:
    """Local/dev-only SQLite repository for beta account/license state."""

    def __init__(self, db_path: str) -> None:
        self.db_path = Path(db_path)

    def register_or_get_device(
        self,
        *,
        device_id: str,
        account_id: str | None,
        app_version: str | None,
        platform: str,
        settings: Settings,
    ) -> LicenseRecord:
        """
        Create a durable license row once, then refresh non-license metadata.

        The first insert owns the trial clock. Updates deliberately avoid
        changing trial timestamps so retries, app launches, or reinstalls cannot
        extend a beta trial by accident.
        """

        now = _utcnow()
        trial_ends_at = now + timedelta(days=settings.trial_days)
        offline_grace_ends_at = trial_ends_at + timedelta(days=settings.offline_grace_days)

        with self._connect() as connection:
            self._ensure_schema(connection)
            connection.execute(
                """
                INSERT INTO device_licenses (
                    device_id,
                    account_id,
                    app_version,
                    platform,
                    registered_at,
                    trial_started_at,
                    trial_ends_at,
                    offline_grace_ends_at,
                    license_state
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'trial_active')
                ON CONFLICT(device_id) DO UPDATE SET
                    account_id = COALESCE(excluded.account_id, account_id),
                    app_version = COALESCE(excluded.app_version, app_version),
                    platform = excluded.platform,
                    updated_at = ?
                """,
                (
                    device_id,
                    account_id,
                    app_version,
                    platform,
                    _format_dt(now),
                    _format_dt(now),
                    _format_dt(trial_ends_at),
                    _format_dt(offline_grace_ends_at),
                    _format_dt(now),
                ),
            )
            row = connection.execute(
                "SELECT * FROM device_licenses WHERE device_id = ?",
                (device_id,),
            ).fetchone()

        return _record_from_row(row)

    def create_account_for_activation(self, *, email: str) -> CreatedAccountRecord:
        """
        Create a stable beta account without treating email as authentication.

        The raw token is returned only for the first activation. Until an OTP or
        magic-code recovery flow exists, repeated activation for the same email
        fails closed instead of handing a durable bearer token to whoever typed
        that email.
        """

        account_id = _account_id_for_email(email)
        account_access_token = _new_account_access_token()
        account_access_token_hash = _account_access_token_digest(account_access_token)
        now = _utcnow()

        with self._connect() as connection:
            self._ensure_schema(connection)
            try:
                connection.execute(
                    """
                    INSERT INTO accounts (
                        account_id,
                        email,
                        account_access_token_hash,
                        created_at,
                        updated_at
                    )
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        account_id,
                        email,
                        account_access_token_hash,
                        _format_dt(now),
                        _format_dt(now),
                    ),
                )
            except sqlite3.IntegrityError as exc:
                raise _account_activation_conflict() from exc
            row = connection.execute(
                "SELECT * FROM accounts WHERE email = ?",
                (email,),
            ).fetchone()

        return CreatedAccountRecord(
            account=_account_from_row(row),
            account_access_token=account_access_token,
        )

    def get_account_by_access_token(self, *, account_access_token: str) -> AccountRecord | None:
        """Look up the account token digest returned by first beta activation."""

        account_access_token_hash = _account_access_token_digest(account_access_token)
        with self._connect() as connection:
            self._ensure_schema(connection)
            row = connection.execute(
                "SELECT * FROM accounts WHERE account_access_token_hash = ?",
                (account_access_token_hash,),
            ).fetchone()

        return _account_from_row(row) if row else None

    def get_device_license_by_account_id(self, *, account_id: str) -> LicenseRecord | None:
        """Return the most recent device license linked to one account."""

        with self._connect() as connection:
            self._ensure_schema(connection)
            row = connection.execute(
                """
                SELECT *
                FROM device_licenses
                WHERE account_id = ?
                ORDER BY registered_at DESC
                LIMIT 1
                """,
                (account_id,),
            ).fetchone()

        return _record_from_row(row) if row else None

    def update_license_state(
        self,
        *,
        device_id: str,
        state: Literal["trial_active", "licensed", "expired"],
    ) -> LicenseRecord:
        """Apply a manual beta support override without touching trial dates."""

        with self._connect() as connection:
            self._ensure_schema(connection)
            connection.execute(
                """
                UPDATE device_licenses
                SET license_state = ?, updated_at = ?
                WHERE device_id = ?
                """,
                (state, _format_dt(_utcnow()), device_id),
            )
            row = connection.execute(
                "SELECT * FROM device_licenses WHERE device_id = ?",
                (device_id,),
            ).fetchone()

        return _record_from_row(row)

    def save_telegram_managed_setup_session(
        self,
        *,
        session: TelegramManagedSetupSession,
    ) -> None:
        """
        Upsert one Telegram setup session into the same SQLite store as licenses.

        The manager bot token is intentionally absent from this schema. The
        child token is sensitive but must survive backend restarts once approval
        succeeds so the app can finish local runtime setup after a reconnect.
        """

        with self._connect() as connection:
            self._ensure_schema(connection)
            connection.execute(
                """
                INSERT INTO telegram_managed_setup_sessions (
                    setup_id,
                    device_id,
                    app_version,
                    account_id,
                    suggested_bot_name,
                    suggested_bot_username,
                    approval_url,
                    expires_at,
                    status,
                    bot_id,
                    bot_username,
                    managed_child_bot_token,
                    last_update_id,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(setup_id) DO UPDATE SET
                    device_id = excluded.device_id,
                    app_version = excluded.app_version,
                    account_id = excluded.account_id,
                    suggested_bot_name = excluded.suggested_bot_name,
                    suggested_bot_username = excluded.suggested_bot_username,
                    approval_url = excluded.approval_url,
                    expires_at = excluded.expires_at,
                    status = excluded.status,
                    bot_id = excluded.bot_id,
                    bot_username = excluded.bot_username,
                    managed_child_bot_token = excluded.managed_child_bot_token,
                    last_update_id = excluded.last_update_id,
                    updated_at = excluded.updated_at
                """,
                _telegram_managed_session_values(session, updated_at=_utcnow()),
            )

    def get_telegram_managed_setup_session(
        self,
        *,
        setup_id: str,
    ) -> TelegramManagedSetupSession | None:
        """Load a Telegram setup session from SQLite without logging sensitive fields."""

        with self._connect() as connection:
            self._ensure_schema(connection)
            row = connection.execute(
                "SELECT * FROM telegram_managed_setup_sessions WHERE setup_id = ?",
                (setup_id,),
            ).fetchone()

        return _telegram_managed_session_from_row(row) if row else None

    def delete_telegram_managed_setup_session(self, *, setup_id: str) -> None:
        """Remove one expired or completed setup session from local SQLite."""

        with self._connect() as connection:
            self._ensure_schema(connection)
            connection.execute(
                "DELETE FROM telegram_managed_setup_sessions WHERE setup_id = ?",
                (setup_id,),
            )

    def delete_expired_telegram_managed_setup_sessions(self, *, now: datetime) -> None:
        """Prune expired Telegram setup sessions from local SQLite."""

        with self._connect() as connection:
            self._ensure_schema(connection)
            connection.execute(
                "DELETE FROM telegram_managed_setup_sessions WHERE expires_at <= ?",
                (_format_dt(now),),
            )

    def _connect(self) -> sqlite3.Connection:
        """Open a short-lived connection and create local/Render disk folders."""

        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _ensure_schema(self, connection: sqlite3.Connection) -> None:
        """
        Create the durable beta schema in-place.

        `account_id` is nullable for now. It gives the next slice a place to
        attach real account/billing identity without changing device rows again.
        """

        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS accounts (
                account_id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                account_access_token_hash TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS telegram_managed_setup_sessions (
                setup_id TEXT PRIMARY KEY,
                device_id TEXT,
                app_version TEXT,
                account_id TEXT,
                suggested_bot_name TEXT NOT NULL,
                suggested_bot_username TEXT NOT NULL,
                approval_url TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('pending', 'connected')),
                bot_id INTEGER,
                bot_username TEXT,
                managed_child_bot_token TEXT,
                last_update_id INTEGER,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS device_licenses (
                device_id TEXT PRIMARY KEY,
                account_id TEXT,
                app_version TEXT,
                platform TEXT NOT NULL,
                registered_at TEXT NOT NULL,
                trial_started_at TEXT NOT NULL,
                trial_ends_at TEXT NOT NULL,
                offline_grace_ends_at TEXT NOT NULL,
                license_state TEXT NOT NULL
                    CHECK (license_state IN ('trial_active', 'licensed', 'expired')),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )


class PostgresLicenseStore:
    """Neon/Postgres-backed repository for production account/license state."""

    def __init__(self, database_url: str) -> None:
        self.database_url = database_url

    def register_or_get_device(
        self,
        *,
        device_id: str,
        account_id: str | None,
        app_version: str | None,
        platform: str,
        settings: Settings,
    ) -> LicenseRecord:
        """
        Create the durable production row once, then refresh device metadata.

        The SQL mirrors the SQLite store so local behavior and production
        behavior stay aligned while using Postgres-native placeholders/types.
        """

        now = _utcnow()
        trial_ends_at = now + timedelta(days=settings.trial_days)
        offline_grace_ends_at = trial_ends_at + timedelta(days=settings.offline_grace_days)

        with self._connect() as connection:
            self._ensure_schema(connection)
            with connection.cursor(cursor_factory=RealDictCursor) as cursor:
                cursor.execute(
                    """
                    INSERT INTO device_licenses (
                        device_id,
                        account_id,
                        app_version,
                        platform,
                        registered_at,
                        trial_started_at,
                        trial_ends_at,
                        offline_grace_ends_at,
                        license_state
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'trial_active')
                    ON CONFLICT(device_id) DO UPDATE SET
                        account_id = COALESCE(excluded.account_id, device_licenses.account_id),
                        app_version = COALESCE(excluded.app_version, device_licenses.app_version),
                        platform = excluded.platform,
                        updated_at = %s
                    """,
                    (
                        device_id,
                        account_id,
                        app_version,
                        platform,
                        now,
                        now,
                        trial_ends_at,
                        offline_grace_ends_at,
                        now,
                    ),
                )
                cursor.execute(
                    "SELECT * FROM device_licenses WHERE device_id = %s",
                    (device_id,),
                )
                row = cursor.fetchone()

        return _record_from_row(row)

    def create_account_for_activation(self, *, email: str) -> CreatedAccountRecord:
        """Create a production beta account and return its raw token once."""

        account_id = _account_id_for_email(email)
        account_access_token = _new_account_access_token()
        account_access_token_hash = _account_access_token_digest(account_access_token)
        now = _utcnow()

        with self._connect() as connection:
            self._ensure_schema(connection)
            with connection.cursor(cursor_factory=RealDictCursor) as cursor:
                try:
                    cursor.execute(
                        """
                        INSERT INTO accounts (
                            account_id,
                            email,
                            account_access_token_hash,
                            created_at,
                            updated_at
                        )
                        VALUES (%s, %s, %s, %s, %s)
                        """,
                        (
                            account_id,
                            email,
                            account_access_token_hash,
                            now,
                            now,
                        ),
                    )
                except psycopg2.IntegrityError as exc:
                    connection.rollback()
                    raise _account_activation_conflict() from exc
                cursor.execute("SELECT * FROM accounts WHERE email = %s", (email,))
                row = cursor.fetchone()

        return CreatedAccountRecord(
            account=_account_from_row(row),
            account_access_token=account_access_token,
        )

    def get_account_by_access_token(self, *, account_access_token: str) -> AccountRecord | None:
        """Resolve the beta account token digest from Neon/Postgres."""

        account_access_token_hash = _account_access_token_digest(account_access_token)
        with self._connect() as connection:
            self._ensure_schema(connection)
            with connection.cursor(cursor_factory=RealDictCursor) as cursor:
                cursor.execute(
                    "SELECT * FROM accounts WHERE account_access_token_hash = %s",
                    (account_access_token_hash,),
                )
                row = cursor.fetchone()

        return _account_from_row(row) if row else None

    def get_device_license_by_account_id(self, *, account_id: str) -> LicenseRecord | None:
        """Return the most recent device license linked to one account."""

        with self._connect() as connection:
            self._ensure_schema(connection)
            with connection.cursor(cursor_factory=RealDictCursor) as cursor:
                cursor.execute(
                    """
                    SELECT *
                    FROM device_licenses
                    WHERE account_id = %s
                    ORDER BY registered_at DESC
                    LIMIT 1
                    """,
                    (account_id,),
                )
                row = cursor.fetchone()

        return _record_from_row(row) if row else None

    def update_license_state(
        self,
        *,
        device_id: str,
        state: Literal["trial_active", "licensed", "expired"],
    ) -> LicenseRecord:
        """Apply a manual beta support override in production Postgres."""

        with self._connect() as connection:
            self._ensure_schema(connection)
            with connection.cursor(cursor_factory=RealDictCursor) as cursor:
                cursor.execute(
                    """
                    UPDATE device_licenses
                    SET license_state = %s, updated_at = %s
                    WHERE device_id = %s
                    """,
                    (state, _utcnow(), device_id),
                )
                cursor.execute(
                    "SELECT * FROM device_licenses WHERE device_id = %s",
                    (device_id,),
                )
                row = cursor.fetchone()

        return _record_from_row(row)

    def save_telegram_managed_setup_session(
        self,
        *,
        session: TelegramManagedSetupSession,
    ) -> None:
        """
        Upsert one Telegram setup session into Neon/Postgres.

        This deliberately reuses the license-store connection path. Adding a
        second database layer here would make local/production behavior drift
        exactly where restart recovery needs to be boring.
        """

        with self._connect() as connection:
            self._ensure_schema(connection)
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO telegram_managed_setup_sessions (
                        setup_id,
                        device_id,
                        app_version,
                        account_id,
                        suggested_bot_name,
                        suggested_bot_username,
                        approval_url,
                        expires_at,
                        status,
                        bot_id,
                        bot_username,
                        managed_child_bot_token,
                        last_update_id,
                        updated_at
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT(setup_id) DO UPDATE SET
                        device_id = excluded.device_id,
                        app_version = excluded.app_version,
                        account_id = excluded.account_id,
                        suggested_bot_name = excluded.suggested_bot_name,
                        suggested_bot_username = excluded.suggested_bot_username,
                        approval_url = excluded.approval_url,
                        expires_at = excluded.expires_at,
                        status = excluded.status,
                        bot_id = excluded.bot_id,
                        bot_username = excluded.bot_username,
                        managed_child_bot_token = excluded.managed_child_bot_token,
                        last_update_id = excluded.last_update_id,
                        updated_at = excluded.updated_at
                    """,
                    _telegram_managed_session_values(session, updated_at=_utcnow()),
                )

    def get_telegram_managed_setup_session(
        self,
        *,
        setup_id: str,
    ) -> TelegramManagedSetupSession | None:
        """Load a Telegram setup session from Neon/Postgres."""

        with self._connect() as connection:
            self._ensure_schema(connection)
            with connection.cursor(cursor_factory=RealDictCursor) as cursor:
                cursor.execute(
                    "SELECT * FROM telegram_managed_setup_sessions WHERE setup_id = %s",
                    (setup_id,),
                )
                row = cursor.fetchone()

        return _telegram_managed_session_from_row(row) if row else None

    def delete_telegram_managed_setup_session(self, *, setup_id: str) -> None:
        """Remove one expired or no-longer-needed setup session from Neon/Postgres."""

        with self._connect() as connection:
            self._ensure_schema(connection)
            with connection.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM telegram_managed_setup_sessions WHERE setup_id = %s",
                    (setup_id,),
                )

    def delete_expired_telegram_managed_setup_sessions(self, *, now: datetime) -> None:
        """Prune expired Telegram setup sessions from Neon/Postgres."""

        with self._connect() as connection:
            self._ensure_schema(connection)
            with connection.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM telegram_managed_setup_sessions WHERE expires_at <= %s",
                    (now,),
                )

    def _connect(self) -> psycopg2.extensions.connection:
        """Open a short-lived Neon connection for request-scoped work."""

        return psycopg2.connect(self.database_url)

    def _ensure_schema(self, connection: psycopg2.extensions.connection) -> None:
        """
        Create the production schema if Neon is empty.

        This keeps first deploy boring: setting `NEON_DATABASE_URL` is enough to
        boot the service, and later account/billing work can reuse `account_id`.
        """

        with connection.cursor() as cursor:
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS accounts (
                    account_id TEXT PRIMARY KEY,
                    email TEXT NOT NULL UNIQUE,
                    account_access_token_hash TEXT NOT NULL UNIQUE,
                    created_at TIMESTAMPTZ NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS device_licenses (
                    device_id TEXT PRIMARY KEY,
                    account_id TEXT,
                    app_version TEXT,
                    platform TEXT NOT NULL,
                    registered_at TIMESTAMPTZ NOT NULL,
                    trial_started_at TIMESTAMPTZ NOT NULL,
                    trial_ends_at TIMESTAMPTZ NOT NULL,
                    offline_grace_ends_at TIMESTAMPTZ NOT NULL,
                    license_state TEXT NOT NULL
                        CHECK (license_state IN ('trial_active', 'licensed', 'expired')),
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS telegram_managed_setup_sessions (
                    setup_id TEXT PRIMARY KEY,
                    device_id TEXT,
                    app_version TEXT,
                    account_id TEXT,
                    suggested_bot_name TEXT NOT NULL,
                    suggested_bot_username TEXT NOT NULL,
                    approval_url TEXT NOT NULL,
                    expires_at TIMESTAMPTZ NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('pending', 'connected')),
                    bot_id BIGINT,
                    bot_username TEXT,
                    managed_child_bot_token TEXT,
                    last_update_id BIGINT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )


def _license_response(
    record: LicenseRecord,
    now: datetime,
    settings: Settings,
) -> LicenseStatusResponse:
    """Convert stored beta state into the existing OpenClaw client contract."""

    state: Literal["trial_active", "trial_expired", "licensed", "expired", "unknown"]
    if record.license_state == "licensed":
        state = "licensed"
    elif record.license_state == "expired":
        state = "expired"
    elif now > record.trial_ends_at:
        state = "trial_expired"
    else:
        state = "trial_active"

    managed_services_enabled = settings.openai_configured or settings.anthropic_configured

    return LicenseStatusResponse(
        state=state,
        deviceId=record.device_id,
        accountId=record.account_id,
        trialStartedAt=record.trial_started_at,
        trialEndsAt=record.trial_ends_at,
        offlineGraceEndsAt=record.offline_grace_ends_at,
        managedServicesEnabled=managed_services_enabled,
    )


def _normalize_email(email: str) -> str:
    """
    Normalize beta account email enough for durable lookup.

    This deliberately avoids adding `email-validator` as a dependency. OAuth or
    email-link verification can own stricter mailbox validation later.
    """

    normalized = email.strip().lower()
    if "@" not in normalized or normalized.startswith("@") or normalized.endswith("@"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Valid account email is required",
        )
    return normalized


def _account_id_for_email(email: str) -> str:
    """Derive a stable opaque id from normalized email without storing raw email in ids."""

    digest = hashlib.sha256(email.encode("utf-8")).hexdigest()[:24]
    return f"acct_{digest}"


def _new_account_access_token() -> str:
    """Issue a local beta token; callers must treat it like a password."""

    return f"jat_{secrets.token_urlsafe(32)}"


def _account_access_token_digest(account_access_token: str) -> str:
    """Hash account bearer tokens so persistence never stores reusable raw tokens."""

    return hashlib.sha256(account_access_token.encode("utf-8")).hexdigest()


def _account_activation_conflict() -> HTTPException:
    """Return the controlled-beta recovery boundary for an already-used email."""

    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=(
            "Account activation already exists for this email. "
            "Account recovery requires a future OTP or magic-code flow."
        ),
    )


def _telegram_managed_session_values(
    session: TelegramManagedSetupSession,
    *,
    updated_at: datetime,
) -> tuple[Any, ...]:
    """
    Normalize Telegram setup session values for both SQLite and Postgres upserts.

    This intentionally excludes the manager token. The child token is persisted
    only after approval so a connected setup can survive a backend restart.
    """

    return (
        session.setup_id,
        session.device_id,
        session.app_version,
        session.account_id,
        session.suggested_bot_name,
        session.suggested_bot_username,
        session.approval_url,
        _format_dt(session.expires_at),
        session.status,
        session.bot_id,
        session.bot_username,
        session.managed_child_bot_token,
        session.last_update_id,
        _format_dt(updated_at),
    )


def _telegram_managed_session_from_row(
    row: sqlite3.Row | dict[str, Any],
) -> TelegramManagedSetupSession:
    """Convert a persisted Telegram setup row back into the internal model."""

    status_value = _read_row_value(row, "status")
    if status_value not in ("pending", "connected"):
        raise HTTPException(status_code=500, detail="Invalid Telegram setup status")

    bot_id_value = _read_row_value(row, "bot_id")
    last_update_id_value = _read_row_value(row, "last_update_id")
    return TelegramManagedSetupSession(
        setup_id=_read_row_value(row, "setup_id"),
        device_id=_read_row_value(row, "device_id"),
        app_version=_read_row_value(row, "app_version"),
        account_id=_read_row_value(row, "account_id"),
        suggested_bot_name=_read_row_value(row, "suggested_bot_name"),
        suggested_bot_username=_read_row_value(row, "suggested_bot_username"),
        approval_url=_read_row_value(row, "approval_url"),
        expires_at=_parse_dt(_read_row_value(row, "expires_at")),
        status=status_value,
        bot_id=bot_id_value if isinstance(bot_id_value, int) else None,
        bot_username=_read_row_value(row, "bot_username"),
        managed_child_bot_token=_read_row_value(row, "managed_child_bot_token"),
        last_update_id=last_update_id_value if isinstance(last_update_id_value, int) else None,
    )


def _account_id_from_access_token(
    store: LicenseStore,
    account_access_token: str | None,
) -> str | None:
    """Resolve optional account context for status checks and fail closed on bad tokens."""

    if not account_access_token:
        return None

    account = store.get_account_by_access_token(account_access_token=account_access_token)
    if not account:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid account access token",
        )
    return account.account_id


def _require_managed_utility_access(
    authorization: str | None,
    settings: Settings,
) -> None:
    """
    Allow managed utilities from either the backend token or a live account token.

    The local runtime can route managed calls with the user-scoped account
    bearer token when no build-scoped backend token is configured.
    """

    if _authorization_matches_backend_token(authorization, settings):
        return

    account_access_token = _authorization_bearer_token(authorization)
    if not account_access_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid account access token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    store = get_license_store(settings)
    account = store.get_account_by_access_token(account_access_token=account_access_token)
    if not account:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid account access token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    record = store.get_device_license_by_account_id(account_id=account.account_id)
    if not record:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Account access token is not linked to an active managed-services license",
        )

    license_response = _license_response(record, _utcnow(), settings)
    if not license_response.managedServicesEnabled or license_response.state not in (
        "trial_active",
        "licensed",
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Account access token is not linked to an active managed-services license",
        )


def _authorization_matches_backend_token(authorization: str | None, settings: Settings) -> bool:
    """Accept the build-scoped backend bearer token when it is configured."""

    if not settings.api_token:
        return False
    return authorization == f"Bearer {settings.api_token}"


def _authorization_bearer_token(authorization: str | None) -> str | None:
    """Extract the raw bearer token from an Authorization header."""

    if not authorization:
        return None
    prefix = "Bearer "
    if not authorization.startswith(prefix):
        return None
    token = authorization[len(prefix) :].strip()
    return token or None


def _provider_presence(settings: Settings) -> dict[str, bool]:
    """Expose key presence only; never return raw provider key material."""

    return {
        "openai": settings.openai_configured,
        "anthropic": settings.anthropic_configured,
        "firecrawl": bool(settings.firecrawl_api_key),
        "google_places": bool(settings.google_places_api_key),
        "gemini": bool(settings.gemini_api_key),
        "brave": bool(settings.brave_api_key),
        "telegram_managed_bots": bool(
            settings.telegram_manager_bot_token and settings.telegram_manager_bot_username
        ),
    }


def _utcnow() -> datetime:
    """Use timezone-aware timestamps so app caches can compare safely."""

    return datetime.now(timezone.utc)


def _format_dt(value: datetime) -> str:
    """Persist timestamps as ISO 8601 strings with explicit UTC offsets."""

    return value.astimezone(timezone.utc).isoformat()


def _parse_dt(value: str | datetime) -> datetime:
    """Load stored timestamps back into aware datetimes for API responses."""

    parsed = value if isinstance(value, datetime) else datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def _read_row_value(row: sqlite3.Row | dict[str, Any], key: str) -> Any:
    """Read one column from either SQLite rows or Postgres dict rows."""

    return row[key]


def _record_from_row(row: sqlite3.Row | dict[str, Any] | None) -> LicenseRecord:
    """Convert a database row to the typed license record model."""

    if row is None:
        raise HTTPException(status_code=404, detail="Device license record not found")

    return LicenseRecord(
        device_id=_read_row_value(row, "device_id"),
        account_id=_read_row_value(row, "account_id"),
        app_version=_read_row_value(row, "app_version"),
        platform=_read_row_value(row, "platform"),
        registered_at=_parse_dt(_read_row_value(row, "registered_at")),
        trial_started_at=_parse_dt(_read_row_value(row, "trial_started_at")),
        trial_ends_at=_parse_dt(_read_row_value(row, "trial_ends_at")),
        offline_grace_ends_at=_parse_dt(_read_row_value(row, "offline_grace_ends_at")),
        license_state=_read_row_value(row, "license_state"),
    )


def _account_from_row(row: sqlite3.Row | dict[str, Any] | None) -> AccountRecord:
    """Convert a database row to the typed beta account record model."""

    if row is None:
        raise HTTPException(status_code=404, detail="Account record not found")

    return AccountRecord(
        account_id=_read_row_value(row, "account_id"),
        email=_read_row_value(row, "email"),
        created_at=_parse_dt(_read_row_value(row, "created_at")),
    )
