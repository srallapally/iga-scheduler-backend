import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

export class SecretManagerParameterResolver {
  constructor({ client = new SecretManagerServiceClient(), projectId = process.env.GCP_PROJECT_ID } = {}) {
    this.client = client;
    this.projectId = projectId;
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

    if (secretRef.startsWith("projects/")) {
      return secretRef.includes("/versions/") ? secretRef : `${secretRef}/versions/latest`;
    }

    if (!this.projectId) {
      throw this.resolutionError("PARAMETER_SECRET_PROJECT_MISSING", "GCP_PROJECT_ID is required for short secretRef values");
    }

    return `projects/${this.projectId}/secrets/${secretRef}/versions/latest`;
  }

  resolutionError(code, message) {
    const error = new Error(message);
    error.code = code;
    error.retryable = false;
    return error;
  }
}
