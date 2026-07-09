export class RunDispatcher {
  constructor({ runStore, workerRunService, intervalMs = 5000, batchSize = 10, logger = console }) {
    if (!runStore) throw new Error("runStore is required");
    if (!workerRunService) throw new Error("workerRunService is required");
    this.runStore = runStore;
    this.workerRunService = workerRunService;
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
    this.logger = logger;
    this._timer = null;
    this._running = false;
  }

  start() {
    this._timer = setInterval(() => { this._pass(); }, this.intervalMs);
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }

  async _pass() {
    if (this._running) return;
    this._running = true;
    try {
      const runIds = await this.runStore.listQueuedRunIds({ limit: this.batchSize });
      for (const runId of runIds) {
        try {
          await this.workerRunService.executeRun({ runId });
        } catch (error) {
          this.logger.warn("dispatch failed", { runId, error: error.message });
        }
      }
    } finally {
      this._running = false;
    }
  }
}
