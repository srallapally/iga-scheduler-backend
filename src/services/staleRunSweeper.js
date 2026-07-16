// Marks RUNNING runs as FAILED when the worker that claimed them has disappeared
// without calling /complete. Threshold = max job timeout + grace buffer.
export class StaleRunSweeper {
  constructor({
    runStore,
    intervalMs = 60000,
    thresholdMs = (1800 + 60) * 1000,
    batchSize = 50,
    logger = console
  }) {
    if (!runStore) throw new Error("runStore is required");
    this.runStore = runStore;
    this.intervalMs = intervalMs;
    this.thresholdMs = thresholdMs;
    this.batchSize = batchSize;
    this.logger = logger;
    this._timer = null;
  }

  start() {
    this._timer = setInterval(() => { this._sweep(); }, this.intervalMs);
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }

  async _sweep() {
    await this._sweepRunning();
    await this._sweepCancelling();
  }

  async _sweepRunning() {
    let runIds;
    try {
      runIds = await this.runStore.listStaleRunningIds({
        thresholdMs: this.thresholdMs,
        limit: this.batchSize
      });
    } catch (error) {
      this.logger.warn("stale running sweep query failed", { error: error.message });
      return;
    }

    for (const runId of runIds) {
      try {
        const marked = await this.runStore.markFailed({
          runId,
          endedAt: new Date().toISOString(),
          error: { code: "STALE_RUNNING", message: "Run marked failed by stale-run sweeper: worker did not call /complete within the timeout window", retryable: false },
          status: { phase: "failed", message: "Run timed out — worker did not complete within the allowed window" }
        });
        if (marked) {
          this.logger.warn("stale run marked failed", { runId });
        }
      } catch (error) {
        this.logger.warn("stale run mark failed error", { runId, error: error.message });
      }
    }
  }

  async _sweepCancelling() {
    let runIds;
    try {
      runIds = await this.runStore.listStaleCancellingIds({
        thresholdMs: this.thresholdMs,
        limit: this.batchSize
      });
    } catch (error) {
      this.logger.warn("stale cancelling sweep query failed", { error: error.message });
      return;
    }

    for (const runId of runIds) {
      try {
        const marked = await this.runStore.markCancelled({
          runId,
          endedAt: new Date().toISOString(),
          error: { code: "STALE_CANCELLING", message: "Run force-cancelled by stale sweeper: worker did not complete within the cancellation timeout window", retryable: false },
          status: { phase: "cancelled", message: "Run force-cancelled — worker did not complete within the allowed window after cancellation was requested" }
        });
        if (marked) {
          this.logger.warn("stale cancelling run force-cancelled", { runId });
        }
      } catch (error) {
        this.logger.warn("stale cancelling mark error", { runId, error: error.message });
      }
    }
  }
}
