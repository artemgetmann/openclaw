# Jarvis Backend MVP

Tiny FastAPI control-plane skeleton for Jarvis Consumer.

This service is intentionally isolated from the OpenClaw local runtime. It gives
the app a stable backend contract for health checks, device registration, trial
license status, and managed-server utility calls. Provider API keys are read
from server environment variables and are never returned to clients.

## Endpoints

- `GET /healthz` - public health check with provider presence booleans only.
- `POST /v1/device/register` - registers or refreshes a device contract.
- `POST /v1/license/status` - returns trial/license status for a device.
- `POST /v1/managed/utilities/{utility}` - placeholder for future managed operations.

## Environment

- `JARVIS_BACKEND_ENV` - defaults to `development`.
- `JARVIS_BACKEND_API_TOKEN` - bearer token for protected endpoints.
- `JARVIS_TRIAL_DAYS` - defaults to `14`.
- `JARVIS_OFFLINE_GRACE_DAYS` - defaults to `3`.
- `OPENAI_API_KEY` - optional managed provider key.
- `ANTHROPIC_API_KEY` - optional managed provider key.

In production, protected endpoints refuse requests if
`JARVIS_BACKEND_API_TOKEN` is missing. In development, the token is optional so
local contract tests can run without secrets.

## Run Locally

```bash
cd services/jarvis-backend
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8787
```

## Test

```bash
cd services/jarvis-backend
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
pytest
```
