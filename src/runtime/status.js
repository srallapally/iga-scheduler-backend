const STATUS_PREFIX = "IGA_STATUS_JSON:";

export function emitStatus(status, { stdout = process.stdout } = {}) {
  stdout.write(`${STATUS_PREFIX}${JSON.stringify(status)}\n`);
}

export function updateStatus(status, options = {}) {
  emitStatus(status, options);
}
