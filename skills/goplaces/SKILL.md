---
name: goplaces
description: Query Google Places API (New) via the goplaces CLI for text search, place details, resolve, and reviews. Use for human-friendly place lookup or JSON output for scripts.
homepage: https://github.com/steipete/goplaces
metadata:
  {
    "openclaw":
      {
        "emoji": "📍",
        "displayName": "Google Maps Search",
        "requires": { "bins": ["node"] },
        "primaryEnv": "GOOGLE_PLACES_API_KEY",
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "steipete/tap/goplaces",
              "bins": ["goplaces"],
              "label": "Install goplaces (brew)",
            },
          ],
      },
  }
---

# Google Maps Search (goplaces)

Modern Google Places search for Jarvis managed mode and BYOK Google Places API
(New) users. Search routes through the Jarvis backend when managed services are
configured; BYOK falls back to the local Google Places key.

Install

- Homebrew: `brew install steipete/tap/goplaces`

Config

- Jarvis managed: no local Google Places key is required for search.
- BYOK/direct: `GOOGLE_PLACES_API_KEY` or `skills.entries.goplaces.apiKey`
  required.
- Optional direct CLI: `GOOGLE_PLACES_BASE_URL` for testing/proxying.

Common commands

- Search: `skills/goplaces/scripts/goplaces-search.sh "coffee near KLCC" --limit 5`
- JSON search: `skills/goplaces/scripts/goplaces-search.sh "sushi" --json`
- Direct CLI bias: `goplaces search "pizza" --lat 40.8 --lng -73.9 --radius-m 3000`
- Direct CLI pagination: `goplaces search "pizza" --page-token "NEXT_PAGE_TOKEN"`
- Direct CLI resolve: `goplaces resolve "Soho, London" --limit 5`
- Direct CLI details: `goplaces details <place_id> --reviews`

Notes

- `--no-color` or `NO_COLOR` disables ANSI color.
- Price levels: 0..4 (free → very expensive).
- Type filter sends only the first `--type` value (API accepts one).

Setup Routing

- For ordinary search, use `skills/goplaces/scripts/goplaces-search.sh` first.
  It chooses Jarvis managed routing when configured and direct BYOK otherwise.
- If BYOK mode has no `GOOGLE_PLACES_API_KEY`, use the shared `consumer-setup`
  skill instead of pretending direct place search is ready.
- Distinguish missing user/API setup from a product-side missing secret.
- Do not add raw Google Places keys to the packaged app bundle as a shortcut.
