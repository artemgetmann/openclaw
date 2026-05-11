import os
import sqlite3

from fastapi.testclient import TestClient
import pytest

from app.main import app, get_settings


@pytest.fixture(autouse=True)
def isolated_backend_db(monkeypatch, tmp_path):
    """Give each test its own SQLite file so trial state cannot leak."""

    monkeypatch.setenv("JARVIS_BACKEND_DB_PATH", str(tmp_path / "jarvis-test.sqlite3"))
    reset_settings()
    yield
    reset_settings()


def reset_settings() -> None:
    """Clear cached env-derived settings between tests."""

    get_settings.cache_clear()


def test_health_reports_provider_presence_without_secret_values(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-openai-provider-placeholder")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    reset_settings()

    response = TestClient(app).get("/healthz")

    assert response.status_code == 200
    body = response.json()
    assert body["providers"] == {"openai": True, "anthropic": False}
    assert "test-openai-provider-placeholder" not in response.text


def test_device_registration_returns_trial_contract_without_token_in_development(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    monkeypatch.delenv("JARVIS_BACKEND_API_TOKEN", raising=False)
    reset_settings()

    response = TestClient(app).post(
        "/v1/device/register",
        json={"device_id": "device-1234", "app_version": "0.1.0", "platform": "macos"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["device_id"] == "device-1234"
    assert body["license"]["state"] == "trial_active"
    assert body["license"]["deviceId"] == "device-1234"


def test_device_registration_reuses_persisted_trial_dates(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    monkeypatch.setenv("JARVIS_TRIAL_DAYS", "14")
    reset_settings()
    client = TestClient(app)

    first = client.post(
        "/v1/device/register",
        json={"device_id": "device-stable", "app_version": "0.1.0", "platform": "macos"},
    )
    second = client.post(
        "/v1/device/register",
        json={"device_id": "device-stable", "app_version": "0.2.0", "platform": "macos"},
    )

    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["registered_at"] == first.json()["registered_at"]
    assert second.json()["license"]["trialStartedAt"] == first.json()["license"]["trialStartedAt"]
    assert second.json()["license"]["trialEndsAt"] == first.json()["license"]["trialEndsAt"]


def test_account_login_activates_trial_and_links_device(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    monkeypatch.setenv("JARVIS_TRIAL_DAYS", "14")
    reset_settings()
    client = TestClient(app)

    activated = client.post(
        "/v1/account/login",
        json={
            "email": " Founder@Example.com ",
            "deviceId": "device-account",
            "appVersion": "0.1.0",
            "platform": "macos",
        },
    )
    status = client.post(
        "/v1/license/status",
        json={
            "deviceId": "device-account",
            "accountAccessToken": activated.json()["accountAccessToken"],
        },
    )

    assert activated.status_code == 200
    activated_body = activated.json()
    assert activated_body["email"] == "founder@example.com"
    assert activated_body["accountId"].startswith("acct_")
    assert activated_body["accountAccessToken"].startswith("jat_")
    assert activated_body["license"]["state"] == "trial_active"
    assert activated_body["license"]["accountId"] == activated_body["accountId"]
    assert status.status_code == 200
    assert status.json()["accountId"] == activated_body["accountId"]
    assert status.json()["trialEndsAt"] == activated_body["license"]["trialEndsAt"]

    db_path = os.environ["JARVIS_BACKEND_DB_PATH"]
    with sqlite3.connect(db_path) as connection:
        row = connection.execute(
            "SELECT account_access_token_hash FROM accounts WHERE email = ?",
            ("founder@example.com",),
        ).fetchone()
    assert row is not None
    assert row[0] != activated_body["accountAccessToken"]
    assert len(row[0]) == 64


def test_account_login_existing_email_fails_closed_without_returning_token(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    reset_settings()
    client = TestClient(app)

    first = client.post(
        "/v1/account/login",
        json={"email": "founder@example.com", "deviceId": "device-repeat", "appVersion": "0.1.0"},
    )
    second = client.post(
        "/v1/account/login",
        json={"email": "founder@example.com", "deviceId": "device-repeat", "appVersion": "0.2.0"},
    )

    assert first.status_code == 200
    assert second.status_code == 409
    assert "accountAccessToken" not in second.text
    assert second.json()["detail"] == (
        "Account activation already exists for this email. "
        "Account recovery requires a future OTP or magic-code flow."
    )


def test_license_status_rejects_invalid_account_token(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    reset_settings()

    response = TestClient(app).post(
        "/v1/license/status",
        json={"deviceId": "device-status", "accountAccessToken": "not-a-real-account-token"},
    )

    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid account access token"


def test_invalid_account_token_does_not_mutate_existing_device_link(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    reset_settings()
    client = TestClient(app)

    activated = client.post(
        "/v1/account/login",
        json={"email": "founder@example.com", "deviceId": "device-linked", "appVersion": "0.1.0"},
    )
    blocked = client.post(
        "/v1/license/status",
        json={
            "deviceId": "device-linked",
            "accountAccessToken": "not-a-real-account-token",
            "appVersion": "0.2.0",
        },
    )
    legacy_status = client.post(
        "/v1/license/status",
        json={"deviceId": "device-linked", "appVersion": "0.3.0"},
    )

    assert activated.status_code == 200
    assert blocked.status_code == 401
    assert legacy_status.status_code == 200
    assert legacy_status.json()["accountId"] == activated.json()["accountId"]
    assert legacy_status.json()["trialStartedAt"] == activated.json()["license"]["trialStartedAt"]


def test_license_status_uses_existing_trial_record(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    reset_settings()
    client = TestClient(app)

    registered = client.post(
        "/v1/device/register",
        json={"device_id": "device-status", "app_version": "0.1.0", "platform": "macos"},
    )
    status = client.post(
        "/v1/license/status",
        json={"deviceId": "device-status", "appVersion": "0.2.0"},
    )

    assert registered.status_code == 200
    assert status.status_code == 200
    assert status.json()["trialStartedAt"] == registered.json()["license"]["trialStartedAt"]
    assert status.json()["trialEndsAt"] == registered.json()["license"]["trialEndsAt"]


def test_admin_license_update_marks_device_licensed_and_expired(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    monkeypatch.setenv("JARVIS_BACKEND_API_TOKEN", "server-token")
    reset_settings()
    client = TestClient(app)
    headers = {"Authorization": "Bearer server-token"}

    registered = client.post(
        "/v1/device/register",
        json={"device_id": "device-admin", "app_version": "0.1.0", "platform": "macos"},
        headers=headers,
    )
    licensed = client.post(
        "/v1/admin/devices/device-admin/license",
        json={"state": "licensed"},
        headers=headers,
    )
    expired = client.post(
        "/v1/admin/devices/device-admin/license",
        json={"state": "expired"},
        headers=headers,
    )

    assert registered.status_code == 200
    assert licensed.status_code == 200
    assert licensed.json()["state"] == "licensed"
    assert expired.status_code == 200
    assert expired.json()["state"] == "expired"


def test_development_uses_local_sqlite_without_neon(monkeypatch, tmp_path):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    monkeypatch.delenv("NEON_DATABASE_URL", raising=False)
    local_db = tmp_path / "explicit-local.sqlite3"
    monkeypatch.setenv("JARVIS_BACKEND_DB_PATH", str(local_db))
    reset_settings()

    response = TestClient(app).post(
        "/v1/device/register",
        json={"device_id": "device-local", "app_version": "0.1.0", "platform": "macos"},
    )

    assert response.status_code == 200
    assert response.json()["license"]["state"] == "trial_active"
    assert local_db.exists()


def test_production_without_neon_keeps_healthz_up_but_fails_persistence(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "production")
    monkeypatch.setenv("JARVIS_BACKEND_API_TOKEN", "server-token")
    monkeypatch.delenv("NEON_DATABASE_URL", raising=False)
    reset_settings()
    client = TestClient(app)
    headers = {"Authorization": "Bearer server-token"}

    health = client.get("/healthz")
    register = client.post(
        "/v1/device/register",
        json={"device_id": "device-prod", "app_version": "0.1.0", "platform": "macos"},
        headers=headers,
    )
    license_status = client.post(
        "/v1/license/status",
        json={"deviceId": "device-prod", "appVersion": "0.1.0"},
        headers=headers,
    )
    admin = client.post(
        "/v1/admin/devices/device-prod/license",
        json={"state": "licensed"},
        headers=headers,
    )

    assert health.status_code == 200
    assert register.status_code == 503
    assert license_status.status_code == 503
    assert admin.status_code == 503
    assert register.json()["detail"] == "NEON_DATABASE_URL is required for production persistence"


def test_production_requires_configured_backend_token(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "production")
    monkeypatch.delenv("JARVIS_BACKEND_API_TOKEN", raising=False)
    reset_settings()

    response = TestClient(app).post("/v1/license/status", json={"deviceId": "device-1234"})

    assert response.status_code == 503


def test_configured_backend_token_is_required(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    monkeypatch.setenv("JARVIS_BACKEND_API_TOKEN", "server-token")
    reset_settings()

    client = TestClient(app)
    unauthorized = client.post("/v1/license/status", json={"deviceId": "device-1234"})
    authorized = client.post(
        "/v1/license/status",
        json={"deviceId": "device-1234"},
        headers={"Authorization": "Bearer server-token"},
    )

    assert unauthorized.status_code == 401
    assert authorized.status_code == 200
    assert authorized.json()["state"] == "trial_active"


def test_managed_utility_never_returns_provider_key(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    monkeypatch.setenv("OPENAI_API_KEY", "test-managed-provider-placeholder")
    reset_settings()

    response = TestClient(app).post(
        "/v1/managed/utilities/provider_status",
        json={"input": {"ignored": True}},
    )

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert response.json()["result"]["providers"]["openai"] is True
    assert "test-managed-provider-placeholder" not in response.text


def teardown_function():
    reset_settings()
    for key in (
        "JARVIS_BACKEND_ENV",
        "JARVIS_BACKEND_API_TOKEN",
        "JARVIS_BACKEND_DB_PATH",
        "JARVIS_TRIAL_DAYS",
        "NEON_DATABASE_URL",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
    ):
        os.environ.pop(key, None)
