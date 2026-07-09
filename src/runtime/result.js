const RESULT_PREFIX = "IGA_RESULT_JSON:";

export function emitResult(output, { stdout = process.stdout } = {}) {
  stdout.write(`${RESULT_PREFIX}${JSON.stringify(output)}\n`);
}

export function complete(output, options = {}) {
  emitResult(output, options);
}
