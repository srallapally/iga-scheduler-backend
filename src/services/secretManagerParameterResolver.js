import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

const SECRET_REF_PATTERN = /^projects\/([^/]+)\/secrets\/([^/]+)(?:\/versions\/(.+))?$/;

const DENIED_SECRET_IDS = new Set([
  "iga-scheduler-db-password",
  "iga-scheduler-iga-client-id",
  "iga-scheduler-iga-client-secret",
  "iga-scheduler-es-api-key",
  "iga-scheduler-github-token"
]);

export class SecretManagerParameterResolver {
  constructor({
    client = new SecretManagerServiceClient(),
    projectId = process.env.GCP_PROJECT_ID,
    paramPrefix = process.env.SECRET_PARAM_PREFIX || "job-param-"
  } = {}) {
    this.client = client;
    this.projectId = projectId;
    this.paramPrefix = paramPrefix;
  }

  async resolveParameters(parameters = {}) {
    const resolved = {};

    for (const [name, parameter] of Object.entries(parameters || {})) {
      if (parameter?.type === "sensitive") {
        resolved[name] = await this.resolveSecretValue(parameter.secretRef);
      } else if (parameter?.type === "string" || parameter?.type === "string[]") {
        resolved[name] = parameter.value;
      }
    }

    return resolved;
  }

  async resolveSecretValue(secretRef) {
    const secretVersionName = this.toSecretVersionName(secretRef);
    const [version] = await this.client.accessSecretVersion({
      name: secretVersionName
    });
    const data = version.payload?.data;

    if (!data) {
      return "";
    }

    return Buffer.from(data).toString("utf8");
  }

  toSecretVersionName(secretRef) {
    if (!secretRef || typeof secretRef !== "string") {
      throw this.resolutionError("PARAMETER_SECRET_REF_INVALID", "secretRef is required");
    }

    let secretId;
    let version;

    if (secretRef.startsWith("projects/")) {
      const match = secretRef.match(SECRET_REF_PATTERN);
      if (!match) {
        throw this.resolutionError("PARAMETER_SECRET_REF_INVALID", `malformed secretRef: ${secretRef}`);
      }

      const [, project, id, ver] = match;
      if (project !== this.projectId) {
        throw this.resolutionError("PARAMETER_SECRET_REF_FORBIDDEN", `secretRef must reference a secret in project "${this.projectId}"`);
      }

      secretId = id;
      version = ver || "latest";
    } else {
      if (secretRef.includes("/")) {
        throw this.resolutionError("PARAMETER_SECRET_REF_INVALID", `malformed secretRef: ${secretRef}`);
      }

      if (!this.projectId) {
        throw this.resolutionError("PARAMETER_SECRET_PROJECT_MISSING", "GCP_PROJECT_ID is required for short secretRef values");
      }

      secretId = secretRef;
      version = "latest";
    }

    this.assertAllowed(secretId);

    return `projects/${this.projectId}/secrets/${secretId}/versions/${version}`;
  }

  assertAllowed(secretId) {
    if (DENIED_SECRET_IDS.has(secretId)) {
      console.warn(`[secretManagerParameterResolver] refused platform secret reference: ${secretId}`);
      throw this.resolutionError("PARAMETER_SECRET_REF_FORBIDDEN", "sensitive parameters may not reference platform secrets");
    }

    if (!secretId.startsWith(this.paramPrefix)) {
      console.warn(`[secretManagerParameterResolver] refused non-job-parameter secret reference: ${secretId}`);
      throw this.resolutionError("PARAMETER_SECRET_REF_FORBIDDEN", `secretRef must reference a job-parameter secret (prefix "${this.paramPrefix}")`);
    }
  }

  resolutionError(code, message) {
    const error = new Error(message);
    error.code = code;
    error.retryable = false;
    return error;
  }
}
