#!/usr/bin/env bash
set -euo pipefail

# Minimal native macOS smoke harness for the consumer app.
# This stays on the reliable side of Peekaboo:
# - verify permissions
# - verify the app is running
# - verify a visible window exists
# - best-effort capture of that window to a screenshot
#
# It does NOT try to click/type through onboarding. Peekaboo can do that, but
# background-safe interaction is not realistic on an actively used Mac because
# focus-stealing is part of reliable native UI control.

APP_NAME="${1:-OpenClaw Consumer}"
OUTPUT_DIR="${2:-/tmp/peekaboo-consumer-smoke}"
SCREENSHOT_PATH="$OUTPUT_DIR/${APP_NAME// /-}.png"

mkdir -p "$OUTPUT_DIR"

if ! command -v peekaboo >/dev/null 2>&1; then
  echo "peekaboo CLI not found on PATH" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq not found on PATH" >&2
  exit 1
fi

PERMS_JSON="$OUTPUT_DIR/permissions.json"
APPS_JSON="$OUTPUT_DIR/apps.json"
WINDOWS_JSON="$OUTPUT_DIR/windows.json"
IMAGE_JSON="$OUTPUT_DIR/image.json"

# Keep every probe on the same local runtime path. Mixing bridge-backed and
# local calls can report contradictory permission/window state when another host
# is advertising a stale bridge socket.
peekaboo permissions --no-remote --json >"$PERMS_JSON"
peekaboo list apps --no-remote --json >"$APPS_JSON"
peekaboo window list --app "$APP_NAME" --no-remote --json >"$WINDOWS_JSON"

# Use Python for the timeout because macOS does not ship GNU timeout.
python3 - "$APP_NAME" "$SCREENSHOT_PATH" "$IMAGE_JSON" <<'PY'
import json
import subprocess
import sys

app_name, screenshot_path, image_json_path = sys.argv[1:4]

cmd = [
    "peekaboo",
    "image",
    "--app",
    app_name,
    "--path",
    screenshot_path,
    "--no-remote",
    "--json",
]

result = {
    "success": False,
    "timed_out": False,
    "stdout": "",
    "stderr": "",
    "returncode": None,
}

try:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    result["stdout"] = proc.stdout
    result["stderr"] = proc.stderr
    result["returncode"] = proc.returncode
    result["success"] = proc.returncode == 0
except subprocess.TimeoutExpired as exc:
    result["timed_out"] = True
    result["stdout"] = exc.stdout or ""
    result["stderr"] = exc.stderr or ""

with open(image_json_path, "w", encoding="utf-8") as fh:
    json.dump(result, fh, indent=2)
PY

jq -n \
  --arg appName "$APP_NAME" \
  --arg screenshotPath "$SCREENSHOT_PATH" \
  --slurpfile perms "$PERMS_JSON" \
  --slurpfile apps "$APPS_JSON" \
  --slurpfile windows "$WINDOWS_JSON" \
  --slurpfile image "$IMAGE_JSON" '
  def appInfo:
    (($apps[0].data.applications // [])
      | map(select(.name == $appName))
      | .[0]) // null;

  def visibleWindow:
    (($windows[0].data.windows // [])
      | map(select(.is_on_screen == true))
      | .[0]) // null;

  {
    app: {
      name: $appName,
      running: (appInfo != null),
      pid: (appInfo.processIdentifier // null),
      bundleIdentifier: (appInfo.bundleIdentifier // null),
      windowCount: (appInfo.windowCount // null)
    },
    permissions: ($perms[0]),
    window: visibleWindow,
    screenshot: {
      path: $screenshotPath,
      success: ($image[0].success // false),
      timedOut: ($image[0].timed_out // false),
      returncode: ($image[0].returncode // null)
    }
  }'
