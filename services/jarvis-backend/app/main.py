from __future__ import annotations

import os
import hashlib
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal, Protocol

from fastapi import Depends, FastAPI, Header, HTTPException, status
import psycopg2
from psycopg2.extras import RealDictCursor
from pydantic import BaseModel, Field

SERVICE_VERSION = "0.1.0"


class Settings(BaseModel):
    """Runtime settings loaded from environment without exposing secret values."""

    environment: str = "development"
    api_token: str | None = None
    trial_days: int = 14
    offline_grace_days: int = 3
    db_path: str = "data/jarvis-backend.sqlite3"
    neon_database_url: str | None = None
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
        db_path=os.getenv("JARVIS_BACKEND_DB_PATH") or "data/jarvis-backend.sqlite3",
        neon_database_url=os.getenv("NEON_DATABASE_URL") or None,
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

    def update_license_state(
        self,
        *,
        device_id: str,
        state: Literal["trial_active", "licensed", "expired"],
    ) -> LicenseRecord:
        """Persist a manual license override for the requested device."""


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


def _provider_presence(settings: Settings) -> dict[str, bool]:
    """Expose key presence only; never return raw provider key material."""

    return {
        "openai": settings.openai_configured,
        "anthropic": settings.anthropic_configured,
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
