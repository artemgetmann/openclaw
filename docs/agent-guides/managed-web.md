# Managed Web Operator Runbook

Use this when you need to prove Jarvis `web_search` and `web_fetch` use the
managed backend. Keep the proof layers separate: local config, backend utility
calls, Jarvis runtime commit, and app bundle state are different facts.

## What This Proves

- The Jarvis config points at managed services and has a backend access token.
- `web_search` reaches the managed `brave.search` backend utility.
- `web_fetch` reaches the managed `firecrawl.scrape` backend utility.
- Local provider environment variables are ignored by the smoke path.
- The running Jarvis gateway is still the expected managed bundle.
- `/Applications/Jarvis.app` was not touched.

## Operator Steps

1. Start from the sacred main clone unless you are only editing docs or code:

   ```bash
   cd ~/Programming_Projects/openclaw
   git status --short --branch
   ```

2. Check redacted config presence. Do not print tokens or provider keys:

   ```bash
   node - <<'NODE'
   const fs = require("node:fs");
   const path = `${process.env.HOME}/Library/Application Support/Jarvis/.jarvis/openclaw.json`;
   const config = JSON.parse(fs.readFileSync(path, "utf8"));
   const jarvis = config.jarvis || {};
   const backend = jarvis.backend || {};
   console.log(JSON.stringify({
     configPath: path,
     mode: jarvis.managedServices?.mode || null,
     backendOrigin: backend.baseUrl ? new URL(backend.baseUrl).origin : null,
     accessTokenConfigured: Boolean(backend.accessToken),
     accountAccessTokenConfigured: Boolean(backend.accountAccessToken),
     deviceIdConfigured: Boolean(backend.deviceId),
   }, null, 2));
   NODE
   ```

3. Run the managed backend smoke with fake local provider values. These values
   should be reported as configured and scrubbed, never used:

   ```bash
   BRAVE_API_KEY=local-brave-should-not-matter \
   FIRECRAWL_API_KEY=local-firecrawl-should-not-matter \
   FIRECRAWL_BASE_URL=https://local-firecrawl.invalid \
   node scripts/smoke-jarvis-managed-web.mjs
   ```

4. Confirm the smoke output:
   - `ok=true`
   - `backend.mode=managed`
   - `backend.tokenConfigured=true`
   - `localProviderEnv.BRAVE_API_KEY.scrubbed=true`
   - `localProviderEnv.FIRECRAWL_API_KEY.scrubbed=true`
   - `localProviderEnv.FIRECRAWL_BASE_URL.scrubbed=true`
   - `web_search` uses utility `brave.search`, provider `brave`
   - `web_fetch` uses utility `firecrawl.scrape`, provider `firecrawl`

5. Prove the running Jarvis runtime commit and health:

   ```bash
   bash scripts/prove-jarvis-runtime.sh --expected-commit <expected-runtime-commit>
   ```

   Expected proof lines include:
   - `service_label=ai.jarvis.gateway`
   - `runtime_source=jarvis-managed-bundle`
   - `runtime_commit=<expected>`
   - `rpc=ok`
   - `health=healthy`
   - `runtime_mutation=none`
   - `applications_jarvis_app=untouched`

## Stop Conditions

- If the smoke output does not show the local provider env vars as scrubbed,
  stop. Do not claim managed backend proof.
- If the provider is not `brave` for `web_search` or not `firecrawl` for
  `web_fetch`, stop and inspect the backend response.
- If `prove-jarvis-runtime.sh` reports a different runtime source or commit,
  report that as runtime drift. Do not restart, rebuild, reseed, or touch
  `/Applications/Jarvis.app` without explicit approval.
- Do not use local `BRAVE_API_KEY`, `FIRECRAWL_API_KEY`, or
  `FIRECRAWL_BASE_URL` as fallback proof. Managed web proof must survive those
  variables being fake, unset, or scrubbed.
