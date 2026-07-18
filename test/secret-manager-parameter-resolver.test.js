import { describe, expect, it, vi } from "vitest";
import { SecretManagerParameterResolver } from "../src/services/secretManagerParameterResolver.js";

function createClient(value = "secret-value") {
  return {
    accessSecretVersion: vi.fn(async () => [{
      payload: {
        data: Buffer.from(value, "utf8")
      }
    }])
  };
}

const PLATFORM_SECRET_IDS = [
  "iga-scheduler-db-password",
  "iga-scheduler-iga-client-id",
  "iga-scheduler-iga-client-secret",
  "iga-scheduler-es-api-key",
  "iga-scheduler-github-token"
];

describe("SecretManagerParameterResolver", () => {
  it("resolves string, string array, and sensitive parameters", async () => {
    const client = createClient("resolved-secret");
    const resolver = new SecretManagerParameterResolver({
      client,
      projectId: "project-1"
    });

    const resolved = await resolver.resolveParameters({
      window: {
        type: "string",
        value: "PT1H"
      },
      apps: {
        type: "string[]",
        value: ["salesforce", "workday"]
      },
      apiKey: {
        type: "sensitive",
        secretRef: "job-param-iga-api-key"
      }
    });

    expect(resolved).toEqual({
      window: "PT1H",
      apps: ["salesforce", "workday"],
      apiKey: "resolved-secret"
    });
    expect(client.accessSecretVersion).toHaveBeenCalledWith({
      name: "projects/project-1/secrets/job-param-iga-api-key/versions/latest"
    });
  });

  it("uses fully qualified secret version names unchanged for an allowed id", async () => {
    const client = createClient();
    const resolver = new SecretManagerParameterResolver({ client, projectId: "project-1" });

    await resolver.resolveParameters({
      token: {
        type: "sensitive",
        secretRef: "projects/project-1/secrets/job-param-token/versions/5"
      }
    });

    expect(client.accessSecretVersion).toHaveBeenCalledWith({
      name: "projects/project-1/secrets/job-param-token/versions/5"
    });
  });

  it("adds latest version to fully qualified secret names without a version", async () => {
    const client = createClient();
    const resolver = new SecretManagerParameterResolver({ client, projectId: "project-1" });

    await resolver.resolveParameters({
      token: {
        type: "sensitive",
        secretRef: "projects/project-1/secrets/job-param-token"
      }
    });

    expect(client.accessSecretVersion).toHaveBeenCalledWith({
      name: "projects/project-1/secrets/job-param-token/versions/latest"
    });
  });

  it("rejects short secret refs when project id is missing", async () => {
    const resolver = new SecretManagerParameterResolver({
      client: createClient(),
      projectId: ""
    });

    await expect(resolver.resolveParameters({
      token: {
        type: "sensitive",
        secretRef: "job-param-token"
      }
    })).rejects.toMatchObject({
      code: "PARAMETER_SECRET_PROJECT_MISSING",
      retryable: false
    });
  });

  describe("job-parameter allowlist (SEC-2)", () => {
    it.each(PLATFORM_SECRET_IDS)("refuses platform secret %s via bare id", async (secretId) => {
      const client = createClient();
      const resolver = new SecretManagerParameterResolver({ client, projectId: "project-1" });

      await expect(resolver.resolveParameters({
        token: { type: "sensitive", secretRef: secretId }
      })).rejects.toMatchObject({
        code: "PARAMETER_SECRET_REF_FORBIDDEN",
        retryable: false
      });
      expect(client.accessSecretVersion).not.toHaveBeenCalled();
    });

    it.each(PLATFORM_SECRET_IDS)("refuses platform secret %s via fully qualified ref", async (secretId) => {
      const client = createClient();
      const resolver = new SecretManagerParameterResolver({ client, projectId: "project-1" });

      await expect(resolver.resolveParameters({
        token: { type: "sensitive", secretRef: `projects/project-1/secrets/${secretId}/versions/latest` }
      })).rejects.toMatchObject({
        code: "PARAMETER_SECRET_REF_FORBIDDEN",
        retryable: false
      });
      expect(client.accessSecretVersion).not.toHaveBeenCalled();
    });

    it("refuses a cross-project fully qualified ref", async () => {
      const client = createClient();
      const resolver = new SecretManagerParameterResolver({ client, projectId: "project-1" });

      await expect(resolver.resolveParameters({
        token: { type: "sensitive", secretRef: "projects/other-project/secrets/job-param-token/versions/latest" }
      })).rejects.toMatchObject({
        code: "PARAMETER_SECRET_REF_FORBIDDEN",
        retryable: false
      });
      expect(client.accessSecretVersion).not.toHaveBeenCalled();
    });

    it("refuses a malformed projects/... ref", async () => {
      const client = createClient();
      const resolver = new SecretManagerParameterResolver({ client, projectId: "project-1" });

      await expect(resolver.resolveParameters({
        token: { type: "sensitive", secretRef: "projects/project-1/notsecrets/job-param-token" }
      })).rejects.toMatchObject({
        code: "PARAMETER_SECRET_REF_INVALID",
        retryable: false
      });
      expect(client.accessSecretVersion).not.toHaveBeenCalled();
    });

    it("refuses a non-prefixed, non-platform secret id", async () => {
      const client = createClient();
      const resolver = new SecretManagerParameterResolver({ client, projectId: "project-1" });

      await expect(resolver.resolveParameters({
        token: { type: "sensitive", secretRef: "random-secret" }
      })).rejects.toMatchObject({
        code: "PARAMETER_SECRET_REF_FORBIDDEN",
        retryable: false
      });
      expect(client.accessSecretVersion).not.toHaveBeenCalled();
    });

    it("resolves a job-param-prefixed secret", async () => {
      const client = createClient("resolved-secret");
      const resolver = new SecretManagerParameterResolver({ client, projectId: "project-1" });

      const resolved = await resolver.resolveParameters({
        apiKey: { type: "sensitive", secretRef: "job-param-salesforce" }
      });

      expect(resolved).toEqual({ apiKey: "resolved-secret" });
      expect(client.accessSecretVersion).toHaveBeenCalledWith({
        name: "projects/project-1/secrets/job-param-salesforce/versions/latest"
      });
    });

    it("honors a custom SECRET_PARAM_PREFIX via constructor injection", async () => {
      const client = createClient("resolved-secret");
      const resolver = new SecretManagerParameterResolver({
        client,
        projectId: "project-1",
        paramPrefix: "custom-prefix-"
      });

      await expect(resolver.resolveParameters({
        token: { type: "sensitive", secretRef: "job-param-token" }
      })).rejects.toMatchObject({ code: "PARAMETER_SECRET_REF_FORBIDDEN" });

      const resolved = await resolver.resolveParameters({
        token: { type: "sensitive", secretRef: "custom-prefix-token" }
      });
      expect(resolved).toEqual({ token: "resolved-secret" });
      expect(client.accessSecretVersion).toHaveBeenCalledWith({
        name: "projects/project-1/secrets/custom-prefix-token/versions/latest"
      });
    });
  });
});
