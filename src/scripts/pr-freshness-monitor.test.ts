import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSnapshot,
  diffSnapshots,
  isActivePullRequest,
  monitorResult,
} from "../../scripts/lib/pr-freshness-monitor.mjs";

const nowMs = Date.parse("2026-08-14T05:00:00Z");
const base = {
  number: 10,
  title: "Keep this PR fresh",
  url: "https://github.com/artemgetmann/openclaw/pull/10",
  state: "OPEN",
  isDraft: false,
  updatedAt: "2026-08-14T04:00:00Z",
  labels: [],
  mergeStateStatus: "CLEAN",
  headRefOid: "a".repeat(40),
  baseRefOid: "b".repeat(40),
  requiredChecks: [],
};

describe("PR freshness monitor", () => {
  it("filters drafts and stale abandoned PRs while retaining opt-ins and active PRs", () => {
    expect(isActivePullRequest(base, { nowMs })).toBe(true);
    expect(isActivePullRequest({ ...base, isDraft: true }, { nowMs })).toBe(false);
    expect(isActivePullRequest({ ...base, updatedAt: "2026-07-01T00:00:00Z" }, { nowMs })).toBe(
      false,
    );
    expect(
      isActivePullRequest(
        { ...base, updatedAt: "2026-07-01T00:00:00Z", labels: [{ name: "pr-freshness-monitor" }] },
        { nowMs },
      ),
    ).toBe(true);
  });

  it("classifies required CI failures, pending noise, drift, blocked readiness, and merges", () => {
    const cases = [
      [{ ...base, requiredChecks: [{ bucket: "fail" }] }, "required-ci-failed"],
      [{ ...base, requiredChecks: [{ bucket: "pending" }] }, "ci-pending"],
      [
        {
          ...base,
          mergeStateStatus: "BLOCKED",
          requiredChecks: [{ bucket: "pending" }],
        },
        "ci-pending",
      ],
      [{ ...base, mergeStateStatus: "BEHIND" }, "base-drift"],
      [{ ...base, mergeStateStatus: "BLOCKED" }, "merge-blocked"],
      [{ ...base, state: "MERGED" }, "merged"],
    ] as const;
    for (const [pr, expected] of cases) {
      expect(buildSnapshot([pr], { nowMs, trackedNumbers: [10] }).pullRequests[0]?.state).toBe(
        expected,
      );
    }
  });

  it("reports a merge only for a previously tracked PR", () => {
    const open = buildSnapshot([base], { nowMs });
    const merged = buildSnapshot([{ ...base, state: "MERGED" }], {
      nowMs: nowMs + 1,
      trackedNumbers: [10],
    });
    expect(diffSnapshots(open, merged)).toEqual([
      expect.objectContaining({ from: "merge-ready", to: "merged" }),
    ]);
    expect(buildSnapshot([{ ...base, state: "MERGED" }], { nowMs }).pullRequests).toEqual([]);
  });

  it("deduplicates unchanged state and suppresses routine pending transitions", () => {
    const pending = buildSnapshot([{ ...base, requiredChecks: [{ bucket: "pending" }] }], {
      nowMs,
    });
    expect(monitorResult(null, pending).changed).toBe(false);
    expect(diffSnapshots(pending, pending)).toEqual([]);
    const failed = buildSnapshot([{ ...base, requiredChecks: [{ bucket: "fail" }] }], {
      nowMs: nowMs + 1,
    });
    expect(diffSnapshots(pending, failed)).toEqual([
      expect.objectContaining({ number: 10, from: "ci-pending", to: "required-ci-failed" }),
    ]);
  });

  it("reports a new actionable head even when the state label is unchanged", () => {
    const before = buildSnapshot([{ ...base, mergeStateStatus: "BEHIND" }], { nowMs });
    const after = buildSnapshot(
      [{ ...base, mergeStateStatus: "BEHIND", headRefOid: "c".repeat(40) }],
      { nowMs: nowMs + 1 },
    );
    expect(diffSnapshots(before, after)).toEqual([
      expect.objectContaining({ number: 10, to: "base-drift", reason: "head-changed" }),
    ]);
  });

  it("bounds output and excludes PR bodies and arbitrary fields", () => {
    const prs = Array.from({ length: 30 }, (_, index) => ({
      ...base,
      number: index + 1,
      body: "private dump",
      title: "private title",
    }));
    const snapshot = buildSnapshot(prs, { nowMs });
    expect(snapshot.pullRequests).toHaveLength(20);
    expect(JSON.stringify(snapshot)).not.toContain("private dump");
    expect(JSON.stringify(snapshot)).not.toContain("private title");
  });

  it("preserves the last good state when fixture input fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-freshness-cli-test-"));
    const state = path.join(root, "state.json");
    const fixture = path.join(root, "fixture.json");
    const script = path.resolve(import.meta.dirname, "../../scripts/pr-freshness-monitor.mjs");
    try {
      fs.writeFileSync(fixture, JSON.stringify([base]));
      expect(
        spawnSync(process.execPath, [script, "--fixture", fixture, "--state-file", state]).status,
      ).toBe(0);
      const good = fs.readFileSync(state, "utf8");
      fs.writeFileSync(fixture, "not json");
      const failed = spawnSync(
        process.execPath,
        [script, "--fixture", fixture, "--state-file", state],
        { encoding: "utf8" },
      );
      expect(failed.status).toBe(1);
      expect(JSON.parse(failed.stdout)).toMatchObject({
        changed: false,
        error: "github-check-failed",
      });
      expect(fs.readFileSync(state, "utf8")).toBe(good);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses only the caller-provided state object and needs no repository mutation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-freshness-test-"));
    try {
      const before = fs.readdirSync(root);
      monitorResult(null, buildSnapshot([base], { nowMs }));
      expect(fs.readdirSync(root)).toEqual(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
