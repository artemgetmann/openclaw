type CronJobDisabler = (jobId: string) => Promise<void>;

let activeCronJobDisabler: CronJobDisabler | undefined;

/**
 * Publish the Gateway-owned scheduler mutation seam for in-process features.
 *
 * Monitor authority executes inside a plugin tool, outside the Gateway method
 * context that normally exposes CronService. Keeping this seam narrow prevents
 * plugins from gaining general scheduler control while still letting a
 * terminal one-shot monitor disable its own already-bound job immediately.
 */
export function setActiveCronJobDisabler(disable: CronJobDisabler): void {
  activeCronJobDisabler = disable;
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
  if (!activeCronJobDisabler) {
    throw new Error("active Gateway cron service is unavailable");
  }
  await activeCronJobDisabler(normalizedJobId);
}
