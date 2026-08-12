#!/usr/bin/env python3
"""Render a compact builder priority report to HTML, PDF, and PNG."""
from __future__ import annotations

import argparse
import html
import json
import shutil
import subprocess
from pathlib import Path


def esc(value: object) -> str:
    return html.escape(str(value or ""), quote=True)


def chrome_path() -> str | None:
    # Prefer known macOS app paths, then common PATH names. Rendering remains
    # useful as HTML when no Chromium-family browser is installed.
    for candidate in (
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ):
        if Path(candidate).exists():
            return candidate
    for name in ("google-chrome", "chromium", "chromium-browser", "msedge"):
        if found := shutil.which(name):
            return found
    return None


def render_html(data: dict) -> str:
    # Keep the input contract intentionally small: actionable rows are separate
    # from the compact non-action sections enforced by the skill itself.
    rows = []
    for item in data.get("items") or []:
        rows.append(
            "<tr>"
            f"<td><span class='priority'>{esc(item.get('priority'))}</span></td>"
            f"<td><strong>{esc(item.get('name'))}</strong><br><code>{esc(item.get('exact_title'))}</code></td>"
            f"<td>{esc(item.get('meaning'))}</td>"
            f"<td><strong>{esc(item.get('decision'))}</strong></td>"
            "</tr>"
        )
    sections = []
    for section in data.get("sections") or []:
        items = "".join(f"<li>{esc(item)}</li>" for item in section.get("items") or [])
        sections.append(f"<section><h2>{esc(section.get('title'))}</h2><ul>{items}</ul></section>")
    return f"""<!doctype html><html><head><meta charset='utf-8'><style>
body{{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif;background:#f5f5f7;color:#111;margin:0;padding:48px}}
main{{max-width:1100px;margin:auto}}header,section,table{{background:white;border:1px solid #ddd;border-radius:24px;box-shadow:0 12px 35px #0001}}
header{{padding:38px;margin-bottom:18px}}h1{{font-size:50px;line-height:1;margin:8px 0 14px}}p{{font-size:20px;line-height:1.45;color:#444}}
table{{width:100%;border-collapse:separate;border-spacing:0;overflow:hidden}}th,td{{padding:18px;text-align:left;vertical-align:top;border-bottom:1px solid #eee}}th{{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:#666}}tr:last-child td{{border:0}}
.priority{{display:inline-block;background:#1769e0;color:white;font-weight:800;border-radius:12px;padding:10px}}code{{font-size:12px;color:#444}}section{{padding:22px 28px;margin-top:16px}}li{{margin:9px 0;line-height:1.4}}
@media print{{body{{padding:24px}}header,section,table{{box-shadow:none;break-inside:avoid}}}}
</style></head><body><main><header><small>{esc(data.get('title') or 'Builder Priority Triage')}</small><h1>{esc(data.get('headline') or 'Only decisions that need you.')}</h1><p>{esc(data.get('boss_answer'))}</p></header>
<table><thead><tr><th>Priority</th><th>Owner</th><th>Meaning</th><th>Your action</th></tr></thead><tbody>{''.join(rows)}</tbody></table>{''.join(sections)}</main></body></html>"""


def screenshot_height(data: dict) -> int:
    # Chromium's CLI captures the viewport, not an automatic full page. Estimate
    # a conservative height from every rendered field so supported ten-item
    # reports and their non-action sections are not silently truncated.
    row_units = 0
    for item in data.get("items") or []:
        text_length = sum(len(str(item.get(key) or "")) for key in ("name", "exact_title", "meaning", "decision"))
        row_units += max(1, (text_length + 179) // 180)
    section_units = sum(
        max(1, (len(str(item)) + 139) // 140)
        for section in data.get("sections") or []
        for item in section.get("items") or []
    )
    section_count = len(data.get("sections") or [])
    return min(20_000, max(1_800, 400 + row_units * 95 + section_units * 70 + section_count * 95))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--basename", default="builder-priority-report")
    args = parser.parse_args()
    data = json.loads(Path(args.input).read_text(encoding="utf-8"))
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    html_path = out_dir / f"{args.basename}.html"
    pdf_path = out_dir / f"{args.basename}.pdf"
    png_path = out_dir / f"{args.basename}.png"
    html_path.write_text(render_html(data), encoding="utf-8")
    if chrome := chrome_path():
        # Chromium produces both sendable formats from the exact same HTML so
        # the PDF and preview cannot silently disagree about priority content.
        url = html_path.resolve().as_uri()
        subprocess.run([chrome, "--headless=new", "--disable-gpu", "--no-first-run", f"--print-to-pdf={pdf_path.resolve()}", url], check=True)
        height = screenshot_height(data)
        subprocess.run([chrome, "--headless=new", "--disable-gpu", "--no-first-run", f"--screenshot={png_path.resolve()}", f"--window-size=1400,{height}", url], check=True)
    print(json.dumps({"html": str(html_path), "pdf": str(pdf_path) if pdf_path.exists() else None, "png": str(png_path) if png_path.exists() else None}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
