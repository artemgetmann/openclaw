type CronJobDisabler = (jobId: string) => Promise<void>;

// The Gateway and Codex plugin are emitted as independent bundles. A normal
// module variable is therefore duplicated, and a bundler may even remove the
// setter from the Gateway copy when it cannot see the Codex copy's read. The
// global symbol is a deliberately private, process-local rendezvous point: it
// shares only this one narrow capability without exposing CronService itself.
const ACTIVE_CRON_JOB_DISABLER_KEY = Symbol.for("openclaw.cron.activeJobDisabler");

type ActiveCronRuntimeGlobal = typeof globalThis & {
  [ACTIVE_CRON_JOB_DISABLER_KEY]?: CronJobDisabler;
};

function activeCronRuntimeGlobal(): ActiveCronRuntimeGlobal {
  return globalThis as ActiveCronRuntimeGlobal;
}

/**
 * Publish the Gateway-owned scheduler mutation seam for in-process features.
 *
 * Monitor authority executes inside a plugin tool, outside the Gateway method
 * context that normally exposes CronService. Keeping this seam narrow prevents
 * plugins from gaining general scheduler control while still letting a
 * terminal one-shot monitor disable its own already-bound job immediately.
 */
export function setActiveCronJobDisabler(disable: CronJobDisabler): () => void {
  activeCronRuntimeGlobal()[ACTIVE_CRON_JOB_DISABLER_KEY] = disable;
  return () => {
    // A hot reload can install a replacement before the previous service has
    // finished stopping. Only the publisher that still owns the slot may clear
    // it; an old disposer must never erase the replacement scheduler seam.
    const runtimeGlobal = activeCronRuntimeGlobal();
    if (runtimeGlobal[ACTIVE_CRON_JOB_DISABLER_KEY] === disable) {
      delete runtimeGlobal[ACTIVE_CRON_JOB_DISABLER_KEY];
    }
  };
}

/**
 * Disable one exact job through the live CronService lock and timer machinery.
 *
 * Fail closed when no Gateway scheduler owns the process. The authority claim
 * is already consumed before this call, so an unavailable scheduler cannot
 * cause the external continuation to execute twice.
 */
export async function disableActiveCronJob(jobId: string): Promise<void> {
  const normalizedJobId = jobId.trim();
  if (!normalizedJobId) {
    throw new Error("cron job id required");
  }
  const disable = activeCronRuntimeGlobal()[ACTIVE_CRON_JOB_DISABLER_KEY];
  if (!disable) {
    throw new Error("active Gateway cron service is unavailable");
  }
  await disable(normalizedJobId);
}
