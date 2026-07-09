import { createEsClient } from "../clients/esClient.js";
import { getConfig } from "../config/index.js";
import { computeNextFireAt } from "../utils/schedule.js";
import { createJobInstanceSchema, patchJobInstanceSchema } from "../validation/jobInstanceSchema.js";

export class JobInstanceService {
  constructor({ instanceStore, esClient, definitionsIndex } = {}) {
    if (!instanceStore) throw new Error("instanceStore is required");
    this.instanceStore = instanceStore;
    this._esClient = esClient || null;
    this._definitionsIndex = definitionsIndex || null;
  }

  get esClient() {
    if (!this._esClient) this._esClient = createEsClient();
    return this._esClient;
  }

  get definitionsIndex() {
    if (!this._definitionsIndex) this._definitionsIndex = getConfig().definitionsIndex;
    return this._definitionsIndex;
  }

  async createInstance(definitionId, body) {
    const definition = await this.getActiveDefinition(definitionId);
    const parsed = createJobInstanceSchema.parse(body);
    const parameterSchema = definition.parameters || [];
    this.validateParametersAgainstDefinition(parsed.parameters, parameterSchema);
    const now = new Date().toISOString();
    const nextFireAt = computeNextFireAt(parsed.schedule);
    const doc = {
      instanceId: parsed.instanceId,
      definitionId,
      definitionVersion: definition.version,
      definitionParameterSchema: parameterSchema,
      enabled: parsed.enabled,
      state: parsed.enabled ? "ACTIVE" : "PAUSED",
      schedule: parsed.schedule,
      nextFireAt,
      lastFireAt: null,
      parameters: parsed.parameters,
      createdAt: now,
      updatedAt: now
    };
    return this.instanceStore.createInstance(doc);
  }

  async patchInstance(instanceId, body) {
    const existing = await this.requireInstance(instanceId);
    const parsed = patchJobInstanceSchema.parse(body);
    const next = { ...existing, ...parsed };
    if (parsed.parameters) this.validateParametersAgainstDefinition(parsed.parameters, existing.definitionParameterSchema || []);
    if (parsed.schedule || parsed.enabled === true) next.nextFireAt = computeNextFireAt(next.schedule);
    next.state = next.enabled ? "ACTIVE" : "PAUSED";
    next.updatedAt = new Date().toISOString();
    return this.instanceStore.updateInstance(instanceId, next);
  }

  async pauseInstance(instanceId) { return this.patchInstance(instanceId, { enabled: false }); }
  async resumeInstance(instanceId) { return this.patchInstance(instanceId, { enabled: true }); }

  async deleteInstance(instanceId) {
    const existing = await this.requireInstance(instanceId);
    const deleted = { ...existing, enabled: false, state: "DELETED", updatedAt: new Date().toISOString() };
    return this.instanceStore.updateInstance(instanceId, deleted);
  }

  async getInstance(instanceId) {
    return this.instanceStore.getInstance(instanceId);
  }

  async listInstancesForDefinition(definitionId) {
    return this.instanceStore.listInstancesForDefinition(definitionId);
  }

  async getActiveDefinition(definitionId) {
    const response = await this.esClient.get({ index: this.definitionsIndex, id: definitionId });
    const definition = response._source;
    if (definition.enabled !== true || definition.state !== "ACTIVE") throw new Error(`Job definition ${definitionId} is not active`);
    return definition;
  }

  async requireInstance(instanceId) {
    const instance = await this.instanceStore.getInstance(instanceId);
    if (!instance) {
      const err = new Error("instance not found");
      err.statusCode = 404;
      throw err;
    }
    return instance;
  }

  validateParametersAgainstDefinition(parameters = {}, parameterSchema = []) {
    for (const parameter of parameterSchema) {
      const supplied = parameters[parameter.name];
      if (parameter.required && supplied === undefined) throw new Error(`Missing required parameter: ${parameter.name}`);
      if (supplied !== undefined) this.validateParameterValue(parameter, supplied);
    }
  }

  validateParameterValue(parameter, supplied) {
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) throw new Error(`Parameter ${parameter.name} must be an object`);
    if (supplied.type !== parameter.type) throw new Error(`Parameter ${parameter.name} must declare type ${parameter.type}`);
    if (parameter.type === "sensitive") {
      if (!supplied.secretRef || typeof supplied.secretRef !== "string") throw new Error(`Parameter ${parameter.name} must include secretRef`);
      return;
    }
    const value = supplied.value;
    if (parameter.type === "string" && typeof value !== "string") throw new Error(`Parameter ${parameter.name} must be a string`);
    if (parameter.type === "string[]" && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) throw new Error(`Parameter ${parameter.name} must be a string array`);
  }
}
