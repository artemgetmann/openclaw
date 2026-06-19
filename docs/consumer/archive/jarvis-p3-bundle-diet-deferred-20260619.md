# Jarvis P3 Bundle Diet Deferred

Archived on 2026-06-19 as a cold breadcrumb, not an active plan.

## Decision

Do not continue bundle-diet work unless package time or release artifact size
becomes an active pain again.

## Completed Slices

- PR #947 pruned bundled Node `include/` headers from the packaged macOS
  runtime.
- PR #948 pruned non-macOS Koffi native payloads while preserving both
  `darwin-arm64` and `darwin-x64` support.

## Deferred Candidate

- `pdfjs-dist` is the next clean technical candidate.
- Estimated packaged raw saving is about 39-40 MiB; compressed release savings
  are likely smaller.
- Current code appears to use only `pdfjs-dist/legacy/build/pdf.mjs`, but
  pruning the package can affect unusual PDFs that need CMaps, font data, ICC
  profiles, wasm or image decoders, web assets, workers, or source maps.

## Product-Level Candidates

Extension pruning is not cleanup. Cutting bundled extensions such as `feishu`,
`diagnostics-otel`, or `diffs` changes what Jarvis ships by default and needs a
product decision before implementation.

## Guardrails

- Do not publish a Jarvis update from bundle-diet work.
- Do not notarize, upload DMG/ZIP/appcast files, or publish GitHub release
  assets for this cleanup.
- Do not touch `/Applications/Jarvis.app`, launchd, Telegram, shared gateway,
  or user runtimes.
- Do not remove Intel/x64 support.
