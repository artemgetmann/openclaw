---
name: peekaboo
description: Capture/inspect macOS UI with the Peekaboo CLI. Use for screenshots, video/capture artifacts, diagnostics, explicit Peekaboo requests, or fallback after Jarvis GUI Control is unavailable; do not use as the default for Jarvis GUI-operation proof.
homepage: https://peekaboo.boo
metadata:
  {
    "openclaw":
      {
        "emoji": "👀",
        "displayName": "Mac Screen Control",
        "os": ["darwin"],
        "requires": { "bins": ["peekaboo"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "steipete/tap/peekaboo",
              "bins": ["peekaboo"],
              "label": "Install Peekaboo (brew)",
            },
          ],
      },
  }
---

# Peekaboo

## Routing Boundary

For ordinary Jarvis GUI-operation requests, first use the `jarvis-gui-control`
skill and the installed `openclaw gui-control` CLI. That path is the product
GUI-control surface backed by OpenComputerUse.

Use Peekaboo when the user asks for screenshots, screen recording/capture,
visual artifacts, UI diagnostics, explicit Peekaboo behavior, or when
`openclaw gui-control` is unavailable and the user accepts a fallback. Do not
present a Peekaboo-only run as proof that Jarvis GUI Control used the intended
OpenComputerUse path.

Peekaboo is a full macOS UI automation CLI: capture/inspect screens, target UI
elements, drive input, and manage apps/windows/menus. Commands share a snapshot
cache and support `--json`/`-j` for scripting. Run `peekaboo` or
`peekaboo <cmd> --help` for flags; `peekaboo --version` prints build metadata.
Tip: run via `polter peekaboo` to ensure fresh builds.

## Jarvis automation rules

Use Peekaboo as Jarvis's eyes and hands, not as Jarvis's brain. The primary
Jarvis/Codex model should inspect screenshots, UI maps, and command output
itself. Peekaboo's `--analyze` path is a debug convenience, not the default
automation path.

Hard rules:

- Always scope actions with `--window-id`, `--app`, or `--pid`. Unscoped clicks,
  typing, pastes, drags, hotkeys, and scrolls can hit the wrong app if focus
  changes.
- Fail loudly before acting when the focused app, window title, window id, or
  process id does not match the intended target. Re-run discovery instead of
  guessing.
- Prefer `peekaboo see` UI/AX element refs (`--on B3`, `--id T2`) over raw
  coordinates. Element refs carry intent; coordinates carry assumptions.
- Screenshot or `see` after every meaningful action and verify the expected
  state changed before continuing.
- Insert text with `peekaboo paste --text "$TEXT" --app AppName` or
  `peekaboo paste --text "$TEXT" --window-id ID`. Positional paste like
  `peekaboo paste "text"` exists in some versions, but it is a convenience
  form, not the safe default for Jarvis flows.
- Avoid `--analyze` by default. Use it only when provider configuration has
  been verified and the task explicitly wants Peekaboo's own AI answer.

Known-bad pattern:

```bash
# Wrong: captures one app, hand-converts screenshot pixels, then clicks whatever
# is focused. This can click Telegram when the intended target was Claude.
peekaboo image --app Claude --retina --path /tmp/claude.png
peekaboo click --coords 1800,1400
```

Safer pattern:

```bash
peekaboo see --app Claude --annotate --path /tmp/claude-see.png --json
peekaboo click --on B4 --app Claude
peekaboo see --app Claude --annotate --path /tmp/claude-after.png --json
```

## `see` vs `image`

- `peekaboo see` captures a target and returns a UI map: element IDs, labels,
  roles, bounds, snapshot IDs, and optional annotated screenshots. Use this for
  target discovery and stable actions.
- `peekaboo image` captures a raw screenshot. Use this when the model needs to
  inspect pixels or when no accessible element map is useful.
- Both commands may support `--analyze`, but Jarvis should not rely on it. Plain
  screenshots and UI maps do not need an API key. `--analyze` does need a
  Peekaboo-configured AI provider because the Peekaboo CLI is separate from the
  Jarvis/Codex model context. Never print raw secret values in examples or logs.

## Coordinate rules

Coordinates are a last resort.

- Never use Retina screenshot pixels directly as click coordinates. Retina
  captures can be 2x native pixels while input coordinates are usually logical
  display coordinates.
- Keep the app/window target on coordinate commands:
  `peekaboo click --coords 120,160 --window-id 12345`.
- Prefer window-relative coordinates when the installed Peekaboo version
  supports them. Use global coordinates only when the task explicitly requires
  display-level positioning.
- Re-capture after coordinate actions and confirm the expected target changed.

## Features (all CLI capabilities, excluding agent/MCP)

Core

- `bridge`: inspect Peekaboo Bridge host connectivity
- `capture`: live capture or video ingest + frame extraction
- `clean`: prune snapshot cache and temp files
- `config`: init/show/edit/validate, providers, models, credentials
- `image`: capture screenshots (screen/window/menu bar regions)
- `learn`: print the full agent guide + tool catalog
- `list`: apps, windows, screens, menubar, permissions
- `permissions`: check Screen Recording/Accessibility status
- `run`: execute `.peekaboo.json` scripts
- `sleep`: pause execution for a duration
- `tools`: list available tools with filtering/display options

Interaction

- `click`: target by ID/query/coords with smart waits
- `drag`: drag & drop across elements/coords/Dock
- `hotkey`: modifier combos like `cmd,shift,t`
- `move`: cursor positioning with optional smoothing
- `paste`: set clipboard -> paste -> restore
- `press`: special-key sequences with repeats
- `scroll`: directional scrolling (targeted + smooth)
- `swipe`: gesture-style drags between targets
- `type`: text + control keys (`--clear`, delays)

System

- `app`: launch/quit/relaunch/hide/unhide/switch/list apps
- `clipboard`: read/write clipboard (text/images/files)
- `dialog`: click/input/file/dismiss/list system dialogs
- `dock`: launch/right-click/hide/show/list Dock items
- `menu`: click/list application menus + menu extras
- `menubar`: list/click status bar items
- `open`: enhanced `open` with app targeting + JSON payloads
- `space`: list/switch/move-window (Spaces)
- `visualizer`: exercise Peekaboo visual feedback animations
- `window`: close/minimize/maximize/move/resize/focus/list

Vision

- `see`: annotated UI maps, snapshot IDs, optional analysis

Global runtime flags

- `--json`/`-j`, `--verbose`/`-v`, `--log-level <level>`
- `--no-remote`, `--bridge-socket <path>`

## Quickstart (happy path)

```bash
peekaboo permissions
peekaboo list apps --json
peekaboo see --app TextEdit --annotate --path /tmp/peekaboo-see.png --json
peekaboo click --on B1 --app TextEdit
peekaboo paste --text "$TEXT" --app TextEdit
peekaboo see --app TextEdit --annotate --path /tmp/peekaboo-after.png --json
```

## Common targeting parameters (most interaction commands)

- App/window: `--app`, `--pid`, `--window-title`, `--window-id`, `--window-index`
- Snapshot targeting: `--snapshot` (ID from `see`; defaults to latest)
- Element/coords: `--on`/`--id` (element ID), `--coords x,y`
- Focus control: `--no-auto-focus`, `--space-switch`, `--bring-to-current-space`,
  `--focus-timeout-seconds`, `--focus-retry-count`

## Common capture parameters

- Output: `--path`, `--format png|jpg`, `--retina`
- Targeting: `--mode screen|window|frontmost`, `--screen-index`,
  `--window-title`, `--window-id`
- Analysis: `--analyze "prompt"`, `--annotate`
- Capture engine: `--capture-engine auto|classic|cg|modern|sckit`

## Common motion/typing parameters

- Timing: `--duration` (drag/swipe), `--steps`, `--delay` (type/scroll/press)
- Human-ish movement: `--profile human|linear`, `--wpm` (typing)
- Scroll: `--direction up|down|left|right`, `--amount <ticks>`, `--smooth`

## Examples

### See -> click -> type (most reliable flow)

```bash
peekaboo see --app Safari --window-title "Login" --annotate --path /tmp/see.png
peekaboo click --on B3 --app Safari
peekaboo paste --text "$EMAIL" --app Safari
peekaboo press tab --count 1 --app Safari
peekaboo paste --text "$PASSWORD" --app Safari
peekaboo press return --app Safari
peekaboo see --app Safari --window-title "Login" --annotate --path /tmp/after.png
```

### Target by window id

```bash
peekaboo list windows --app "Visual Studio Code" --json
peekaboo click --window-id 12345 --coords 120,160
peekaboo paste --text "$TEXT" --window-id 12345
peekaboo see --window-id 12345 --annotate --path /tmp/vscode-after.png --json
```

### Capture screenshots + optional analysis

```bash
peekaboo image --mode screen --screen-index 0 --retina --path /tmp/screen.png
peekaboo image --app Safari --window-title "Dashboard" --path /tmp/dashboard.png

# Debug-only: use analysis only after provider config is verified.
peekaboo image --app Safari --window-title "Dashboard" --analyze "$PROMPT"
peekaboo see --mode screen --screen-index 0 --analyze "$PROMPT"
```

### Live capture (motion-aware)

```bash
peekaboo capture live --mode region --region 100,100,800,600 --duration 30 \
  --active-fps 8 --idle-fps 2 --highlight-changes --path /tmp/capture
```

### App + window management

```bash
peekaboo app launch "Safari" --open https://example.com
peekaboo window focus --app Safari --window-title "Example"
peekaboo window set-bounds --app Safari --x 50 --y 50 --width 1200 --height 800
peekaboo app quit --app Safari
```

### Menus, menubar, dock

```bash
peekaboo menu click --app Safari --item "New Window"
peekaboo menu click --app TextEdit --path "Format > Font > Show Fonts"
peekaboo menu click-extra --title "WiFi"
peekaboo dock launch Safari
peekaboo menubar list --json
```

### Mouse + gesture input

```bash
peekaboo see --app Safari --annotate --path /tmp/safari-before-gesture.png --json
peekaboo drag --from B1 --to T2 --app Safari
peekaboo scroll --direction down --amount 6 --smooth --app Safari
peekaboo see --app Safari --annotate --path /tmp/safari-after-gesture.png --json
```

### Keyboard input

```bash
peekaboo hotkey --keys "cmd,shift,t" --app Safari
peekaboo press escape --app Safari
peekaboo paste --text "$MULTILINE_TEXT" --app TextEdit
```

Notes

- Requires Screen Recording + Accessibility permissions.
- Use `peekaboo see --annotate` to identify targets before clicking.
