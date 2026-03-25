# Docs and content

## Mintlify rules

- Internal links in `docs/**/*.md` are root-relative and omit `.md` or `.mdx`.
- Section links use root-relative anchors.
- Avoid em dashes and apostrophes in headings because they break Mintlify anchors.
- In README files meant for GitHub, keep absolute docs URLs.

## Writing rules

- Use American English.
- For docs, UI copy, and picker lists, order services alphabetically unless the section is explicitly about runtime order.
- Use generic placeholders, not personal hostnames, device names, or live paths.

## i18n

- `docs/zh-CN/**` is generated. Do not edit it unless the user explicitly asks.
- Default flow:
  - Update English docs
  - Update `docs/.i18n/glossary.zh-CN.json` for new fixed terms
  - Run `scripts/docs-i18n`
- See `docs/.i18n/README.md` for the full translation pipeline.

## Helpful references

- `docs/.i18n/README.md`
- `docs/testing.md`
