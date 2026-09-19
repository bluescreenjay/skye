// Background jobs for agent runs (research 1). A press returns at once and the work carries on in
// this same server process; a run left over from a stopped process is reaped by age instead
// (see runs.ts). The registry lives on `globalThis`, like the budget, the limiter, and the chat
// lock, so it survives module reloads and tests can wait for every job to finish.
type Holder = typeof globalThis & { __aiBrowserAgentJobs?: Set<Promise<void>> };

function jobs(): Set<Promise<void>> {
  const holder = globalThis as Holder;
  return (holder.__aiBrowserAgentJobs ??= new Set());
}

/** Starts `work` in the background. Whatever it throws is swallowed and never logged: the work marks its own run failed. */
export function startJob(work: () => Promise<void>): void {
  const set = jobs();
  const job: Promise<void> = Promise.resolve()
    .then(work)
    .catch(() => undefined)
    .finally(() => {
      set.delete(job);
    });
  set.add(job);
}

/** Resolves when no job is running. Tests await this after pressing an agent. */
export async function idle(): Promise<void> {
  while (jobs().size > 0) await Promise.allSettled([...jobs()]);
}

/** Tests only. */
export function resetJobsForTests(): void {
  delete (globalThis as Holder).__aiBrowserAgentJobs;
}
