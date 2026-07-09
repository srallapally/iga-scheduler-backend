import fs from "fs/promises";
import { createIgaHelpers } from "./iga.js";
import { createParameterReader } from "./params.js";

export async function loadRuntimeContext({ env = process.env, readFile = fs.readFile } = {}) {
  const contextFile = env.IGA_SCHEDULER_CONTEXT_FILE;
  if (!contextFile || typeof contextFile !== "string") throw runtimeContextError("RUNTIME_CONTEXT_FILE_REQUIRED", "IGA_SCHEDULER_CONTEXT_FILE is required");
  let raw;
  try { raw = await readFile(contextFile, "utf8"); } catch (error) { throw runtimeContextError("RUNTIME_CONTEXT_FILE_READ_FAILED", `failed to read runtime context file: ${error.message}`, { cause: error }); }
  let context;
  try { context = JSON.parse(raw); } catch (error) { throw runtimeContextError("RUNTIME_CONTEXT_JSON_INVALID", `runtime context JSON is invalid: ${error.message}`, { cause: error }); }
  if (!context || typeof context !== "object" || Array.isArray(context)) throw runtimeContextError("RUNTIME_CONTEXT_INVALID", "runtime context must be a JSON object");
  return context;
}

export async function createRuntimeContext(options = {}) {
  const context = await loadRuntimeContext(options);
  const params = context.params || {};
  return { raw: context, runId: context.runId, definition: context.definition, instance: context.instance, scheduledFireTime: context.scheduledFireTime, attempt: context.attempt, params, param: createParameterReader(params), iga: createIgaHelpers({ client: options.igaClient, bridge: options.igaBridge || createContextBridge(context.igaBridge) }) };
}

function createContextBridge(config) {
  if (!config) return undefined;
  return { invoke: async () => { const error = new Error("runtime IGA bridge transport is not configured in this SDK build"); error.code = "RUNTIME_IGA_BRIDGE_TRANSPORT_UNAVAILABLE"; throw error; } };
}

function runtimeContextError(code, message, { cause } = {}) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}
