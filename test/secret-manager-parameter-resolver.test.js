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
        secretRef: "iga-api-key"
      }
    });

    expect(resolved).toEqual({
      window: "PT1H",
      apps: ["salesforce", "workday"],
      apiKey: "resolved-secret"
    });
    expect(client.accessSecretVersion).toHaveBeenCalledWith({
      name: "projects/project-1/secrets/iga-api-key/versions/latest"
    });
  });

  it("uses fully qualified secret version names unchanged", async () => {
    const client = createClient();
    const resolver = new SecretManagerParameterResolver({ client });

    await resolver.resolveParameters({
      token: {
        type: "sensitive",
        secretRef: "projects/project-1/secrets/token/versions/5"
      }
    });

    expect(client.accessSecretVersion).toHaveBeenCalledWith({
      name: "projects/project-1/secrets/token/versions/5"
    });
  });

  it("adds latest version to fully qualified secret names without a version", async () => {
    const client = createClient();
    const resolver = new SecretManagerParameterResolver({ client });

    await resolver.resolveParameters({
      token: {
        type: "sensitive",
        secretRef: "projects/project-1/secrets/token"
      }
    });

    expect(client.accessSecretVersion).toHaveBeenCalledWith({
      name: "projects/project-1/secrets/token/versions/latest"
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
        secretRef: "token"
      }
    })).rejects.toMatchObject({
      code: "PARAMETER_SECRET_PROJECT_MISSING",
      retryable: false
    });
  });
});
