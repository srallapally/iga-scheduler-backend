// Pull-worker poll loop (AVL-1 residual). Discovers and claims QUEUED runs
// directly from Postgres via RunStore.claimNextQueued, instead of waiting
// for the scheduler to push them over HTTP, and executes each in-process via
// WorkerRunService.executeClaimedRun. Also heartbeats its owned runs and
// detects an operator-requested cancel, invoking JobRuntimeExecutor.cancel
// directly -- no HTTP hop, since the worker that owns the subprocess is the
// one that cancels it. Cloud Run schedules this as a fixed warm pool (see
// terraform's worker_pool_size); this loop has no inbound requests, so it
// can't rely on request-based autoscaling.
export function createPollLoop({
  runStore,
  workerRunService,
  executor,
  activeExecutions,
  maxConcurrency = Number(process.env.WORKER_MAX_CONCURRENCY || 10),
  pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS || 1000),
  heartbeatIntervalMs = Number(process.env.WORKER_HEARTBEAT_INTERVAL_MS || 15000),
  now = () => new Date(),
  logger = console
} = {}) {
  let stopped = true;
  let pollTimer = null;
  let heartbeatTimer = null;
  // Tracks runs this instance currently owns (runId -> dispatchId), for the
  // heartbeat/cancel-watch loop -- distinct from `activeExecutions`, which
  // tracks the in-flight promises themselves for drain purposes.
  const owned = new Map();

  function track(runId, dispatchId, promise) {
    owned.set(runId, dispatchId);
    activeExecutions.add(promise);
    const cleanup = () => { owned.delete(runId); activeExecutions.delete(promise); };
    promise.then(cleanup, cleanup);
  }

  // Callable directly (e.g. from tests) regardless of start()/stop() state --
  // only the scheduled recurring loop itself is gated by `stopped`.
  async function pollOnce() {
    const freeSlots = maxConcurrency - activeExecutions.size;
    if (freeSlots <= 0) return [];

    let claimed;
    try {
      claimed = await runStore.claimNextQueued({ limit: freeSlots, startedAt: now().toISOString() });
    } catch (error) {
      logger.error?.("[worker] poll claim failed:", error.message);
      return [];
    }

    for (const { runId, dispatchId } of claimed) {
      const promise = workerRunService.executeClaimedRun({ runId, dispatchId })
        .catch((error) => logger.error?.(`[worker] execution failed for run ${runId}:`, error.message));
      track(runId, dispatchId, promise);
    }
    return claimed;
  }

  async function heartbeatOnce() {
    for (const [runId, dispatchId] of [...owned.entries()]) {
      try {
        const state = await runStore.touchHeartbeat({ runId, dispatchId, heartbeatAt: now().toISOString() });
        if (state === "CANCELLING" && executor.cancel) executor.cancel(runId);
      } catch (error) {
        logger.error?.(`[worker] heartbeat failed for run ${runId}:`, error.message);
      }
    }
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    const scheduleNext = () => {
      pollTimer = setTimeout(async () => {
        await pollOnce();
        if (!stopped) scheduleNext();
      }, pollIntervalMs);
    };
    scheduleNext();
    heartbeatTimer = setInterval(heartbeatOnce, heartbeatIntervalMs);
  }

  // Stops claiming immediately (in-flight executions are left running --
  // draining them is workerApp.js's `drain()`, driven off the same
  // `activeExecutions` set this loop tracks into).
  function stop() {
    stopped = true;
    if (pollTimer) clearTimeout(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    pollTimer = null;
    heartbeatTimer = null;
  }

  return { start, stop, pollOnce, heartbeatOnce, owned };
}
