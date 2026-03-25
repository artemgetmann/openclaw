# Release and security

## Security first

- Read `SECURITY.md` before advisory review, triage, or severity decisions.
- Do not edit security-owned paths unless a listed owner asked for the change or is already reviewing.

## GHSA workflow

- Fetch advisories with:
  - `gh api /repos/openclaw/openclaw/security-advisories/<GHSA>`
- Build long descriptions with a file or heredoc, not embedded `\n`.
- Patch advisory JSON through a file. Do not try to set `severity` and `cvss_vector_string` in the same PATCH.
- Publish by PATCHing the advisory with `"state":"published"`.

## Release guardrails

- Do not change version numbers without explicit approval.
- Do not run publish or release steps without explicit approval.
- Core `openclaw` publishes use GitHub trusted publishing.
- `@openclaw/*` plugins use a separate maintainer-only auth flow.

## Version locations

- `package.json`
- `apps/android/app/build.gradle.kts`
- `apps/ios/Sources/Info.plist`
- `apps/ios/Tests/Info.plist`
- `apps/macos/Sources/OpenClaw/Resources/Info.plist`
- `docs/install/updating.md`
- Peekaboo Xcode project version fields

## Changelog and beta rules

- Changelog entries are user-facing only.
- Append new entries to the end of the active section.
- Beta git tags should publish matching beta npm versions, not plain versions under the beta dist-tag.
