export class RunDispatcher {
  constructor({
    runStore,
    workerRunService,
    intervalMs = 5000,
    batchSize = 10,
    backoffThreshold = 3,
    maxBackoffMs = 60000,
    logger = console
  }) {
    if (!runStore) throw new Error("runStore is required");
    if (!workerRunService) throw new Error("workerRunService is required");
    this.runStore = runStore;
    this.workerRunService = workerRunService;
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
    this.backoffThreshold = backoffThreshold;
    this.maxBackoffMs = maxBackoffMs;
    this.logger = logger;
    this._timer = null;
    this._running = false;
    this._consecutiveFailures = 0;
  }

  start() {
    this._schedule(this.intervalMs);
  }

  stop() {
    clearTimeout(this._timer);
    this._timer = null;
  }

  _schedule(delayMs) {
    this._timer = setTimeout(() => { this._pass(); }, delayMs);
  }

  _backoffMs() {
    if (this._consecutiveFailures < this.backoffThreshold) return this.intervalMs;
    const exponent = this._consecutiveFailures - this.backoffThreshold;
    return Math.min(this.intervalMs * Math.pow(2, exponent), this.maxBackoffMs);
  }

  async _pass() {
    if (this._running) {
      this._schedule(this.intervalMs);
      return;
    }
    this._running = true;
    let anySuccess = false;
    try {
      const runIds = await this.runStore.listQueuedRunIds({ limit: this.batchSize });
      for (const runId of runIds) {
        try {
          await this.workerRunService.executeRun({ runId });
          anySuccess = true;
        } catch (error) {
          this.logger.warn("dispatch failed", { runId, error: error.message });
        }
      }
      if (anySuccess) {
        this._consecutiveFailures = 0;
      } else if (runIds.length > 0) {
        this._consecutiveFailures += 1;
      }
    } catch (error) {
      this._consecutiveFailures += 1;
      this.logger.warn("dispatch pass failed", { error: error.message });
    } finally {
      this._running = false;
      if (this._timer !== null) {
        this._schedule(this._backoffMs());
      }
    }
  }
}
