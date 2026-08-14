const ACTIONABLE = new Set([
  "required-ci-failed",
  "base-drift",
  "merge-blocked",
  "merge-ready",
  "merged",
]);

// Keep every string written to durable state bounded. PR bodies and titles are
// intentionally never selected, so the cron result cannot leak private content.
function text(value, max = 160) {
  const normalized = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
}

export function isActivePullRequest(pr, options = {}) {
  if (pr?.state !== "OPEN" || pr?.isDraft === true) {
    return false;
  }
  const labels = Array.isArray(pr.labels) ? pr.labels.map((label) => label?.name ?? label) : [];
  if (labels.includes(options.optInLabel ?? "pr-freshness-monitor")) {
    return true;
  }
  if (pr.autoMergeRequest) {
    return true;
  }
  const updated = Date.parse(pr.updatedAt ?? "");
  const now = options.nowMs ?? Date.now();
  const activeWindowMs = (options.activeHours ?? 168) * 60 * 60 * 1000;
  return Number.isFinite(updated) && now - updated <= activeWindowMs;
}

// Classification order matters: an explicit required-check failure is more
// actionable than GitHub's broader merge-state summary for the same PR.
export function classifyPullRequest(pr) {
  if (pr.state === "MERGED") {
    return "merged";
  }
  const checks = Array.isArray(pr.requiredChecks) ? pr.requiredChecks : [];
  if (checks.some((check) => check.bucket === "fail")) {
    return "required-ci-failed";
  }
  if (pr.mergeStateStatus === "BEHIND" || pr.mergeStateStatus === "DIRTY") {
    return "base-drift";
  }
  if (checks.some((check) => check.bucket === "pending")) {
    return "ci-pending";
  }
  if (pr.mergeStateStatus === "BLOCKED") {
    return "merge-blocked";
  }
  if (["CLEAN", "HAS_HOOKS", "UNSTABLE"].includes(pr.mergeStateStatus)) {
    return "merge-ready";
  }
  return "watching";
}

export function buildSnapshot(rawPullRequests, options = {}) {
  const maxPullRequests = Math.min(Math.max(options.maxPullRequests ?? 20, 1), 20);
  const trackedNumbers = new Set(options.trackedNumbers ?? []);
  const active = rawPullRequests
    .filter(
      (pr) =>
        isActivePullRequest(pr, options) ||
        (pr?.state === "MERGED" && trackedNumbers.has(Number(pr.number))),
    )
    .toSorted((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""))
    .slice(0, maxPullRequests)
    .map((pr) => ({
      number: Number(pr.number),
      headSha: text(pr.headRefOid, 40),
      baseSha: text(pr.baseRefOid, 40),
      updatedAt: pr.updatedAt,
      autoMerge: Boolean(pr.autoMergeRequest),
      state: classifyPullRequest(pr),
      requiredChecks: (pr.requiredChecks ?? []).slice(0, 30).map((check) => ({
        name: text(check.name, 100),
        workflow: text(check.workflow, 100),
        bucket: check.bucket,
        state: text(check.state, 40),
      })),
    }));
  return {
    schemaVersion: 1,
    generatedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
    pullRequests: active,
  };
}

export function diffSnapshots(previous, current) {
  const before = new Map((previous?.pullRequests ?? []).map((pr) => [pr.number, pr]));
  const transitions = [];
  for (const pr of current.pullRequests) {
    const prior = before.get(pr.number);
    // A new head deserves a fresh actionable receipt even when its state label
    // is unchanged; this is how a new failing push avoids stale deduplication.
    const actionableStateChange = prior && prior.state !== pr.state && ACTIONABLE.has(pr.state);
    const actionableHeadChange = prior && prior.headSha !== pr.headSha && ACTIONABLE.has(pr.state);
    if ((!prior && ACTIONABLE.has(pr.state)) || actionableStateChange || actionableHeadChange) {
      transitions.push({
        number: pr.number,
        from: prior?.state ?? null,
        to: pr.state,
        reason: actionableHeadChange ? "head-changed" : "state-changed",
      });
    }
  }
  return transitions;
}

export function monitorResult(previous, current) {
  const transitions = diffSnapshots(previous, current);
  return {
    schemaVersion: 1,
    generatedAt: current.generatedAt,
    changed: transitions.length > 0,
    transitions,
    summary: {
      activeCount: current.pullRequests.length,
      states: Object.fromEntries(
        [...new Set(current.pullRequests.map((pr) => pr.state))]
          .toSorted((left, right) => left.localeCompare(right))
          .map((state) => [state, current.pullRequests.filter((pr) => pr.state === state).length]),
      ),
    },
  };
}
