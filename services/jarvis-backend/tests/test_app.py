import json
import logging
import os
import sqlite3

from fastapi.testclient import TestClient
import httpx
import pytest

from app.main import app, get_settings, telegram_managed_setup_sessions


@pytest.fixture(autouse=True)
def isolated_backend_db(monkeypatch, tmp_path):
    """Give each test its own SQLite file so trial state cannot leak."""

    monkeypatch.setenv("JARVIS_BACKEND_DB_PATH", str(tmp_path / "jarvis-test.sqlite3"))
    telegram_managed_setup_sessions.clear()
    reset_settings()
    yield
    telegram_managed_setup_sessions.clear()
    reset_settings()


def reset_settings() -> None:
    """Clear cached env-derived settings between tests."""

    get_settings.cache_clear()


def install_mock_async_client(monkeypatch, handler) -> None:
    """Route provider HTTP through httpx MockTransport so tests never hit the network."""

    real_async_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)

    def make_client(*args, **kwargs):
        return real_async_client(*args, transport=transport, **kwargs)

    monkeypatch.setattr("app.main.httpx.AsyncClient", make_client)


def backend_token_headers(token: str = "server-token") -> dict[str, str]:
    """Build the backend bearer header used by managed-utility contract tests."""

    return {"Authorization": f"Bearer {token}"}


def test_health_reports_provider_presence_without_secret_values(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-openai-provider-placeholder")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("FIRECRAWL_API_KEY", "test-firecrawl-provider-placeholder")
    monkeypatch.setenv("GOOGLE_PLACES_API_KEY", "test-places-provider-placeholder")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setenv("BRAVE_API_KEY", "test-brave-provider-placeholder")
    reset_settings()

    response = TestClient(app).get("/healthz")

    assert response.status_code == 200
    body = response.json()
    assert body["providers"] == {
        "openai": True,
        "anthropic": False,
        "firecrawl": True,
        "google_places": True,
        "gemini": False,
        "brave": True,
        "telegram_managed_bots": False,
    }
    assert "test-openai-provider-placeholder" not in response.text
    assert "test-firecrawl-provider-placeholder" not in response.text
    assert "test-places-provider-placeholder" not in response.text
    assert "test-brave-provider-placeholder" not in response.text


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


def test_telegram_managed_start_missing_config_fails_closed(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    monkeypatch.delenv("TELEGRAM_MANAGER_BOT_TOKEN", raising=False)
    monkeypatch.delenv("MANAGER_BOT_USERNAME", raising=False)
    reset_settings()

    response = TestClient(app).post(
        "/v1/telegram/managed/start",
        json={"deviceId": "device-telegram", "appVersion": "0.1.0"},
    )

    assert response.status_code == 503
    assert response.json()["detail"] == "telegram managed bots provider is not configured"


def test_telegram_managed_start_returns_approval_url_without_secret_values(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    monkeypatch.setenv("TELEGRAM_MANAGER_BOT_TOKEN", "123456:test-manager-token")
    monkeypatch.setenv("MANAGER_BOT_USERNAME", "@JarvisManagerBot")
    reset_settings()

    client = TestClient(app)
    response = client.post(
        "/v1/telegram/managed/start",
        json={
            "deviceId": "device-telegram",
            "appVersion": "0.1.0",
            "suggestedBotName": "Jarvis Founder Bot",
            "suggestedBotUsername": "@founder_jarvis_bot",
        },
    )
    health = client.get("/healthz")

    assert response.status_code == 200
    body = response.json()
    assert body["setupId"].startswith("tgms_")
    assert body["approvalUrl"] == (
        "https://t.me/newbot/JarvisManagerBot/founder_jarvis_bot"
        "?name=Jarvis%20Founder%20Bot"
    )
    assert body["suggestedBotUsername"] == "founder_jarvis_bot"
    assert body["status"] == "pending"
    assert health.json()["providers"]["telegram_managed_bots"] is True
    assert "123456:test-manager-token" not in response.text
    assert "123456:test-manager-token" not in health.text
    assert "123456:test-manager-token" not in repr(get_settings())


def test_telegram_managed_status_returns_pending_when_no_matching_update(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    monkeypatch.setenv("TELEGRAM_MANAGER_BOT_TOKEN", "123456:test-manager-token")
    monkeypatch.setenv("MANAGER_BOT_USERNAME", "JarvisManagerBot")
    reset_settings()

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == (
            "https://api.telegram.org/bot123456:test-manager-token/getUpdates"
        )
        assert json.loads(request.content) == {
            "limit": 20,
            "timeout": 0,
            "allowed_updates": ["managed_bot"],
        }
        return httpx.Response(
            200,
            json={
                "ok": True,
                "result": [
                    {
                        "update_id": 101,
                        "managed_bot": {
                            "bot": {"id": 9001, "is_bot": True, "username": "other_bot"}
                        },
                    }
                ],
            },
        )

    install_mock_async_client(monkeypatch, handler)
    client = TestClient(app)
    started = client.post(
        "/v1/telegram/managed/start",
        json={"suggestedBotUsername": "founder_jarvis_bot"},
    )

    response = client.get(f"/v1/telegram/managed/status/{started.json()['setupId']}")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "pending"
    assert body["suggestedBotUsername"] == "founder_jarvis_bot"
    assert body["botId"] is None
    assert body["managedChildBotToken"] is None


def test_telegram_managed_pending_status_logs_safe_update_metadata(monkeypatch, caplog):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    monkeypatch.setenv("TELEGRAM_MANAGER_BOT_TOKEN", "123456:test-manager-token")
    monkeypatch.setenv("MANAGER_BOT_USERNAME", "JarvisManagerBot")
    reset_settings()
    caplog.set_level(logging.INFO, logger="jarvis_backend.telegram_managed")

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url).endswith("/getUpdates")
        return httpx.Response(
            200,
            json={
                "ok": True,
                "result": [
                    {
                        "update_id": 101,
                        "managed_bot": {
                            "bot": {"id": 9001, "is_bot": True, "username": "other_bot"}
                        },
                    },
                    {"update_id": 102, "message": {"text": "ignored"}},
                ],
            },
        )

    install_mock_async_client(monkeypatch, handler)
    client = TestClient(app)
    started = client.post(
        "/v1/telegram/managed/start",
        json={"suggestedBotUsername": "founder_jarvis_bot"},
    )

    response = client.get(f"/v1/telegram/managed/status/{started.json()['setupId']}")

    assert response.status_code == 200
    log_text = caplog.text
    assert "telegram managed setup poll started" in log_text
    assert "update_count=2" in log_text
    assert "update_ids=[101, 102]" in log_text
    assert "managed_bot_count=1" in log_text
    assert "other_bot" in log_text
    assert "test-manager-token" not in log_text


def test_telegram_managed_pending_session_survives_memory_clear(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    monkeypatch.setenv("TELEGRAM_MANAGER_BOT_TOKEN", "123456:test-manager-token")
    monkeypatch.setenv("MANAGER_BOT_USERNAME", "JarvisManagerBot")
    reset_settings()
    requests_seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests_seen.append(str(request.url))
        return httpx.Response(200, json={"ok": True, "result": []})

    install_mock_async_client(monkeypatch, handler)
    client = TestClient(app)
    started = client.post(
        "/v1/telegram/managed/start",
        json={"deviceId": "device-telegram", "suggestedBotUsername": "founder_jarvis_bot"},
    )
    telegram_managed_setup_sessions.clear()

    response = client.get(f"/v1/telegram/managed/status/{started.json()['setupId']}")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "pending"
    assert body["suggestedBotUsername"] == "founder_jarvis_bot"
    assert body["managedChildBotToken"] is None
    assert requests_seen == ["https://api.telegram.org/bot123456:test-manager-token/getUpdates"]


def test_telegram_managed_status_connects_child_bot_and_returns_token(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    monkeypatch.setenv("TELEGRAM_MANAGER_BOT_TOKEN", "123456:test-manager-token")
    monkeypatch.setenv("MANAGER_BOT_USERNAME", "JarvisManagerBot")
    reset_settings()
    requests_seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests_seen.append(str(request.url))
        if str(request.url).endswith("/getUpdates"):
            assert json.loads(request.content) == {
                "limit": 20,
                "timeout": 0,
                "allowed_updates": ["managed_bot"],
            }
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "result": [
                        {
                            "update_id": 102,
                            "managed_bot": {
                                "bot": {
                                    "id": 777000,
                                    "is_bot": True,
                                    "username": "founder_jarvis_bot",
                                }
                            },
                        }
                    ],
                },
            )
        if str(request.url).endswith("/getManagedBotToken"):
            assert json.loads(request.content) == {"user_id": 777000}
            return httpx.Response(200, json={"ok": True, "result": "777000:test-child-token"})
        if str(request.url).endswith("/getMe"):
            assert str(request.url) == "https://api.telegram.org/bot777000:test-child-token/getMe"
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "result": {
                        "id": 777000,
                        "is_bot": True,
                        "first_name": "Jarvis",
                        "username": "founder_jarvis_bot",
                    },
                },
            )
        if str(request.url).endswith("/setManagedBotAccessSettings"):
            assert json.loads(request.content) == {
                "user_id": 777000,
                "is_access_restricted": True,
            }
            return httpx.Response(200, json={"ok": True, "result": True})
        raise AssertionError(f"unexpected Telegram request: {request.url}")

    install_mock_async_client(monkeypatch, handler)
    client = TestClient(app)
    started = client.post(
        "/v1/telegram/managed/start",
        json={"suggestedBotUsername": "founder_jarvis_bot"},
    )

    response = client.get(f"/v1/telegram/managed/status/{started.json()['setupId']}")
    second_status = client.get(f"/v1/telegram/managed/status/{started.json()['setupId']}")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "connected"
    assert body["botId"] == 777000
    assert body["botUsername"] == "founder_jarvis_bot"
    assert body["managedChildBotToken"] == "777000:test-child-token"
    assert second_status.status_code == 200
    assert second_status.json()["managedChildBotToken"] == "777000:test-child-token"
    assert len([url for url in requests_seen if url.endswith("/getUpdates")]) == 1


def test_telegram_managed_connected_session_survives_memory_clear(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    monkeypatch.setenv("TELEGRAM_MANAGER_BOT_TOKEN", "123456:test-manager-token")
    monkeypatch.setenv("MANAGER_BOT_USERNAME", "JarvisManagerBot")
    reset_settings()
    requests_seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests_seen.append(str(request.url))
        if str(request.url).endswith("/getUpdates"):
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "result": [
                        {
                            "update_id": 102,
                            "managed_bot": {
                                "bot": {
                                    "id": 777000,
                                    "is_bot": True,
                                    "username": "founder_jarvis_bot",
                                }
                            },
                        }
                    ],
                },
            )
        if str(request.url).endswith("/getManagedBotToken"):
            return httpx.Response(200, json={"ok": True, "result": "777000:test-child-token"})
        if str(request.url).endswith("/getMe"):
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "result": {"id": 777000, "is_bot": True, "username": "founder_jarvis_bot"},
                },
            )
        if str(request.url).endswith("/setManagedBotAccessSettings"):
            return httpx.Response(200, json={"ok": True, "result": True})
        raise AssertionError(f"unexpected Telegram request: {request.url}")

    install_mock_async_client(monkeypatch, handler)
    client = TestClient(app)
    started = client.post(
        "/v1/telegram/managed/start",
        json={"suggestedBotUsername": "founder_jarvis_bot"},
    )
    setup_id = started.json()["setupId"]

    connected = client.get(f"/v1/telegram/managed/status/{setup_id}")
    telegram_managed_setup_sessions.clear()
    recovered = client.get(f"/v1/telegram/managed/status/{setup_id}")

    assert connected.status_code == 200
    assert recovered.status_code == 200
    body = recovered.json()
    assert body["status"] == "connected"
    assert body["botId"] == 777000
    assert body["botUsername"] == "founder_jarvis_bot"
    assert body["managedChildBotToken"] == "777000:test-child-token"
    assert len([url for url in requests_seen if url.endswith("/getUpdates")]) == 1


def test_telegram_managed_expired_session_returns_gone_and_prunes(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    monkeypatch.setenv("TELEGRAM_MANAGER_BOT_TOKEN", "123456:test-manager-token")
    monkeypatch.setenv("MANAGER_BOT_USERNAME", "JarvisManagerBot")
    reset_settings()
    client = TestClient(app)
    started = client.post(
        "/v1/telegram/managed/start",
        json={"suggestedBotUsername": "founder_jarvis_bot"},
    )
    setup_id = started.json()["setupId"]
    expired_at = "2020-01-01T00:00:00+00:00"
    with sqlite3.connect(os.environ["JARVIS_BACKEND_DB_PATH"]) as connection:
        connection.execute(
            "UPDATE telegram_managed_setup_sessions SET expires_at = ? WHERE setup_id = ?",
            (expired_at, setup_id),
        )
    telegram_managed_setup_sessions.clear()

    response = client.get(f"/v1/telegram/managed/status/{setup_id}")

    assert response.status_code == 410
    assert response.json()["detail"] == "Telegram setup expired"
    with sqlite3.connect(os.environ["JARVIS_BACKEND_DB_PATH"]) as connection:
        row = connection.execute(
            "SELECT setup_id FROM telegram_managed_setup_sessions WHERE setup_id = ?",
            (setup_id,),
        ).fetchone()
    assert row is None


def test_telegram_managed_status_sanitizes_telegram_api_error(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    monkeypatch.setenv("TELEGRAM_MANAGER_BOT_TOKEN", "123456:test-manager-token")
    monkeypatch.setenv("MANAGER_BOT_USERNAME", "JarvisManagerBot")
    reset_settings()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            401,
            json={
                "ok": False,
                "error_code": 401,
                "description": "Unauthorized 123456:test-manager-token",
            },
        )

    install_mock_async_client(monkeypatch, handler)
    client = TestClient(app)
    started = client.post(
        "/v1/telegram/managed/start",
        json={"suggestedBotUsername": "founder_jarvis_bot"},
    )

    response = client.get(f"/v1/telegram/managed/status/{started.json()['setupId']}")

    assert response.status_code == 502
    assert response.json()["detail"]["provider"] == "telegram"
    assert response.json()["detail"]["method"] == "getUpdates"
    assert response.json()["detail"]["payload"]["description"] == "Unauthorized [redacted]"
    assert "123456:test-manager-token" not in response.text


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


def test_firecrawl_search_calls_provider_and_redacts_echoed_key(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    monkeypatch.setenv("JARVIS_BACKEND_API_TOKEN", "server-token")
    monkeypatch.setenv("FIRECRAWL_API_KEY", "test-firecrawl-provider-placeholder")
    reset_settings()

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://api.firecrawl.dev/v2/search"
        assert request.headers["authorization"] == "Bearer test-firecrawl-provider-placeholder"
        assert json.loads(request.content) == {"query": "founder mode", "limit": 3}
        return httpx.Response(
            200,
            json={
                "success": True,
                "data": [{"title": "Jarvis", "url": "https://example.com"}],
                "creditsUsed": 2,
                "debug": "test-firecrawl-provider-placeholder",
            },
        )

    install_mock_async_client(monkeypatch, handler)

    response = TestClient(app).post(
        "/v1/managed/utilities/firecrawl.search",
        json={"input": {"query": "founder mode", "limit": 3}},
        headers=backend_token_headers(),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["result"]["provider"] == "firecrawl"
    assert body["result"]["payload"]["data"][0]["title"] == "Jarvis"
    assert body["result"]["payload"]["debug"] == "[redacted]"
    assert body["usage"]["units"] == 2
    assert "test-firecrawl-provider-placeholder" not in response.text


def test_firecrawl_scrape_calls_provider_with_markdown_format(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    monkeypatch.setenv("JARVIS_BACKEND_API_TOKEN", "server-token")
    monkeypatch.setenv("FIRECRAWL_API_KEY", "test-firecrawl-provider-placeholder")
    reset_settings()

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://api.firecrawl.dev/v2/scrape"
        assert request.headers["authorization"] == "Bearer test-firecrawl-provider-placeholder"
        assert json.loads(request.content) == {
            "url": "https://example.com",
            "formats": ["markdown"],
        }
        return httpx.Response(
            200,
            json={"success": True, "data": {"markdown": "# Example"}, "creditsUsed": 1},
        )

    install_mock_async_client(monkeypatch, handler)

    response = TestClient(app).post(
        "/v1/managed/utilities/firecrawl.scrape",
        json={"input": {"url": "https://example.com"}},
        headers=backend_token_headers(),
    )

    assert response.status_code == 200
    assert response.json()["result"]["provider"] == "firecrawl"
    assert response.json()["result"]["payload"]["data"]["markdown"] == "# Example"
    assert "test-firecrawl-provider-placeholder" not in response.text


def test_google_places_search_calls_provider_and_redacts_echoed_key(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    monkeypatch.setenv("JARVIS_BACKEND_API_TOKEN", "server-token")
    monkeypatch.setenv("GOOGLE_PLACES_API_KEY", "test-places-provider-placeholder")
    reset_settings()

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://places.googleapis.com/v1/places:searchText"
        assert request.headers["x-goog-api-key"] == "test-places-provider-placeholder"
        assert "places.displayName" in request.headers["x-goog-fieldmask"]
        assert json.loads(request.content) == {"textQuery": "coffee near KLCC", "pageSize": 4}
        return httpx.Response(
            200,
            json={
                "places": [
                    {
                        "id": "place-123",
                        "displayName": {"text": "Coffee Bar"},
                        "formattedAddress": "Kuala Lumpur",
                    }
                ],
                "debug": "test-places-provider-placeholder",
            },
        )

    install_mock_async_client(monkeypatch, handler)

    response = TestClient(app).post(
        "/v1/managed/utilities/google_places.search",
        json={"input": {"query": "coffee near KLCC", "limit": 4}},
        headers=backend_token_headers(),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["result"]["provider"] == "google_places"
    assert body["result"]["payload"]["places"][0]["id"] == "place-123"
    assert body["result"]["payload"]["debug"] == "[redacted]"
    assert "test-places-provider-placeholder" not in response.text


def test_brave_search_calls_provider_and_redacts_echoed_key(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    monkeypatch.setenv("JARVIS_BACKEND_API_TOKEN", "server-token")
    monkeypatch.setenv("BRAVE_API_KEY", "test-brave-provider-placeholder")
    reset_settings()

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url).startswith("https://api.search.brave.com/res/v1/web/search?")
        assert request.headers["x-subscription-token"] == "test-brave-provider-placeholder"
        assert request.url.params["q"] == "managed search"
        assert request.url.params["count"] == "4"
        assert request.url.params["country"] == "US"
        assert request.url.params["search_lang"] == "en"
        return httpx.Response(
            200,
            json={
                "web": {
                    "results": [
                        {
                            "title": "Jarvis",
                            "url": "https://example.com",
                            "description": "Managed result",
                        }
                    ]
                },
                "debug": "test-brave-provider-placeholder",
            },
        )

    install_mock_async_client(monkeypatch, handler)

    response = TestClient(app).post(
        "/v1/managed/utilities/brave.search",
        json={
            "input": {
                "query": "managed search",
                "count": 4,
                "country": "US",
                "search_lang": "en",
            }
        },
        headers=backend_token_headers(),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["result"]["provider"] == "brave"
    assert body["result"]["payload"]["web"]["results"][0]["title"] == "Jarvis"
    assert body["result"]["payload"]["debug"] == "[redacted]"
    assert "test-brave-provider-placeholder" not in response.text


def test_gemini_image_generate_calls_provider_and_returns_inline_image(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    monkeypatch.setenv("JARVIS_BACKEND_API_TOKEN", "server-token")
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-provider-placeholder")
    reset_settings()

    def handler(request: httpx.Request) -> httpx.Response:
        assert (
            str(request.url)
            == "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent"
        )
        assert request.headers["x-goog-api-key"] == "test-gemini-provider-placeholder"
        assert json.loads(request.content) == {
            "contents": [{"parts": [{"text": "tiny robot assistant"}]}],
            "generationConfig": {
                "responseModalities": ["TEXT", "IMAGE"],
                "imageConfig": {"imageSize": "2K", "aspectRatio": "16:9"},
            },
        }
        return httpx.Response(
            200,
            json={
                "candidates": [
                    {
                        "content": {
                            "parts": [
                                {"text": "Generated a small robot."},
                                {
                                    "inlineData": {
                                        "mimeType": "image/png",
                                        "data": "ZmFrZS1pbWFnZQ==",
                                    }
                                },
                            ]
                        }
                    }
                ],
                "usageMetadata": {"totalTokenCount": 1120},
                "debug": "test-gemini-provider-placeholder",
            },
        )

    install_mock_async_client(monkeypatch, handler)

    response = TestClient(app).post(
        "/v1/managed/utilities/gemini.image.generate",
        json={
            "input": {
                "prompt": "tiny robot assistant",
                "resolution": "2K",
                "aspectRatio": "16:9",
            }
        },
        headers=backend_token_headers(),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["result"]["provider"] == "gemini"
    assert body["result"]["payload"]["model"] == "gemini-3-pro-image-preview"
    assert body["result"]["payload"]["text"] == "Generated a small robot."
    assert body["result"]["payload"]["images"] == [
        {"mimeType": "image/png", "data": "ZmFrZS1pbWFnZQ=="}
    ]
    assert body["result"]["payload"]["usageMetadata"]["totalTokenCount"] == 1120
    assert body["usage"]["units"] == 1
    assert "test-gemini-provider-placeholder" not in response.text


def test_gemini_image_generate_validates_prompt_before_provider_spend(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    monkeypatch.setenv("JARVIS_BACKEND_API_TOKEN", "server-token")
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-provider-placeholder")
    reset_settings()

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"unexpected provider request: {request.url}")

    install_mock_async_client(monkeypatch, handler)

    response = TestClient(app).post(
        "/v1/managed/utilities/gemini.image.generate",
        json={"input": {"prompt": "tiny robot assistant", "resolution": "8K"}},
        headers=backend_token_headers(),
    )

    assert response.status_code == 400
    assert response.json()["detail"] == (
        "gemini.image.generate input.resolution must be one of: 1K, 2K, 4K"
    )


def test_openai_audio_transcribe_calls_provider_and_redacts_key(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    monkeypatch.setenv("JARVIS_BACKEND_API_TOKEN", "server-token")
    monkeypatch.setenv("OPENAI_API_KEY", "test-openai-provider-placeholder")
    reset_settings()

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://api.openai.com/v1/audio/transcriptions"
        assert request.headers["authorization"] == "Bearer test-openai-provider-placeholder"
        assert b'name="model"\r\n\r\ngpt-4o-mini-transcribe' in request.content
        assert b'name="language"\r\n\r\nen' in request.content
        assert b'name="prompt"\r\n\r\nTranscribe the audio.' in request.content
        assert b'name="file"; filename="voice.ogg"' in request.content
        assert b"fake-audio-bytes" in request.content
        return httpx.Response(
            200,
            json={
                "text": "wake up my friend",
                "debug": "test-openai-provider-placeholder",
            },
        )

    install_mock_async_client(monkeypatch, handler)

    response = TestClient(app).post(
        "/v1/managed/utilities/openai.audio.transcribe",
        json={
            "input": {
                "fileBase64": "ZmFrZS1hdWRpby1ieXRlcw==",
                "fileName": "voice.ogg",
                "mimeType": "audio/ogg",
                "model": "gpt-4o-mini-transcribe",
                "language": "en",
                "prompt": "Transcribe the audio.",
            }
        },
        headers=backend_token_headers(),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["result"]["provider"] == "openai"
    assert body["result"]["payload"] == {
        "text": "wake up my friend",
        "model": "gpt-4o-mini-transcribe",
    }
    assert "test-openai-provider-placeholder" not in response.text


def test_openai_audio_transcribe_requires_provider_key(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    monkeypatch.setenv("JARVIS_BACKEND_API_TOKEN", "server-token")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    reset_settings()

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"unexpected provider request: {request.url}")

    install_mock_async_client(monkeypatch, handler)

    response = TestClient(app).post(
        "/v1/managed/utilities/openai.audio.transcribe",
        json={"input": {"fileBase64": "ZmFrZS1hdWRpby1ieXRlcw=="}},
        headers=backend_token_headers(),
    )

    assert response.status_code == 503
    assert response.json()["detail"] == "openai provider is not configured"


def test_managed_utility_missing_provider_key_fails_closed(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    monkeypatch.setenv("JARVIS_BACKEND_API_TOKEN", "server-token")
    monkeypatch.delenv("FIRECRAWL_API_KEY", raising=False)
    reset_settings()

    response = TestClient(app).post(
        "/v1/managed/utilities/firecrawl.search",
        json={"input": {"query": "founder mode"}},
        headers=backend_token_headers(),
    )

    assert response.status_code == 503
    assert response.json()["detail"] == "firecrawl provider is not configured"
    assert response.json().get("ok") is None


def test_managed_utility_accepts_account_token_with_active_managed_license(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    monkeypatch.setenv("OPENAI_API_KEY", "test-openai-provider-placeholder")
    monkeypatch.setenv("FIRECRAWL_API_KEY", "test-firecrawl-provider-placeholder")
    reset_settings()
    client = TestClient(app)

    activated = client.post(
        "/v1/account/login",
        json={
            "email": "founder@example.com",
            "deviceId": "device-managed-account",
            "appVersion": "0.1.0",
        },
    )

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://api.firecrawl.dev/v2/search"
        assert request.headers["authorization"] == "Bearer test-firecrawl-provider-placeholder"
        assert json.loads(request.content) == {"query": "managed account", "limit": 2}
        return httpx.Response(
            200,
            json={
                "success": True,
                "data": [{"title": "Jarvis", "url": "https://example.com"}],
                "creditsUsed": 1,
            },
        )

    install_mock_async_client(monkeypatch, handler)

    response = client.post(
        "/v1/managed/utilities/firecrawl.search",
        json={"input": {"query": "managed account", "limit": 2}},
        headers={"Authorization": f"Bearer {activated.json()['accountAccessToken']}"},
    )

    assert activated.status_code == 200
    assert activated.json()["license"]["managedServicesEnabled"] is True
    assert response.status_code == 200
    assert response.json()["result"]["provider"] == "firecrawl"
    assert response.json()["result"]["payload"]["data"][0]["title"] == "Jarvis"


def test_managed_utility_rejects_invalid_token(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    monkeypatch.setenv("FIRECRAWL_API_KEY", "test-firecrawl-provider-placeholder")
    reset_settings()

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"unexpected provider request: {request.url}")

    install_mock_async_client(monkeypatch, handler)

    response = TestClient(app).post(
        "/v1/managed/utilities/firecrawl.search",
        json={"input": {"query": "founder mode"}},
        headers={"Authorization": "Bearer definitely-not-valid"},
    )

    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid account access token"


def test_managed_utility_rejects_expired_account_token(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    monkeypatch.setenv("JARVIS_BACKEND_API_TOKEN", "server-token")
    monkeypatch.setenv("OPENAI_API_KEY", "test-openai-provider-placeholder")
    monkeypatch.setenv("FIRECRAWL_API_KEY", "test-firecrawl-provider-placeholder")
    reset_settings()
    client = TestClient(app)

    activated = client.post(
        "/v1/account/login",
        json={
            "email": "founder@example.com",
            "deviceId": "device-expired-account",
            "appVersion": "0.1.0",
        },
        headers=backend_token_headers(),
    )
    expired = client.post(
        "/v1/admin/devices/device-expired-account/license",
        json={"state": "expired"},
        headers=backend_token_headers(),
    )

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"unexpected provider request: {request.url}")

    install_mock_async_client(monkeypatch, handler)

    response = client.post(
        "/v1/managed/utilities/firecrawl.search",
        json={"input": {"query": "founder mode"}},
        headers={"Authorization": f"Bearer {activated.json()['accountAccessToken']}"},
    )

    assert activated.status_code == 200
    assert expired.status_code == 200
    assert response.status_code == 401
    assert response.json()["detail"] == (
        "Account access token is not linked to an active managed-services license"
    )


def test_unknown_managed_utility_returns_not_found(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "development")
    monkeypatch.setenv("JARVIS_BACKEND_API_TOKEN", "server-token")
    reset_settings()

    response = TestClient(app).post(
        "/v1/managed/utilities/provider_status",
        json={"input": {"ignored": True}},
        headers=backend_token_headers(),
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Unknown managed utility: provider_status"


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
        "FIRECRAWL_API_KEY",
        "GOOGLE_PLACES_API_KEY",
        "GEMINI_API_KEY",
        "BRAVE_API_KEY",
        "TELEGRAM_MANAGER_BOT_TOKEN",
        "MANAGER_BOT_USERNAME",
    ):
        os.environ.pop(key, None)
