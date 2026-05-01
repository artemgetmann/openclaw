import os

from fastapi.testclient import TestClient

from app.main import app, get_settings


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


def test_production_requires_configured_backend_token(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "production")
    monkeypatch.delenv("JARVIS_BACKEND_API_TOKEN", raising=False)
    reset_settings()

    response = TestClient(app).post("/v1/license/status", json={"deviceId": "device-1234"})

    assert response.status_code == 503


def test_configured_backend_token_is_required(monkeypatch):
    monkeypatch.setenv("JARVIS_BACKEND_ENV", "production")
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
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
    ):
        os.environ.pop(key, None)
