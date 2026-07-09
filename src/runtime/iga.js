export function createIgaHelpers({ client, bridge } = {}) {
  if (bridge) {
    return createBridgeIgaHelpers({ bridge });
  }

  if (!client) {
    return createUnavailableIgaHelpers();
  }

  return {
    riskScores: {
      recompute: (input) => client.post("/scheduler/risk-scores/recompute", input)
    },
    health: {
      check: () => client.get("/info/ping")
    },
    get: (path) => client.get(path),
    post: (path, body) => client.post(path, body)
  };
}

function createBridgeIgaHelpers({ bridge }) {
  return {
    riskScores: {
      recompute: (input) => bridge.invoke({ capability: "riskScores.recompute", input })
    },
    health: {
      check: () => bridge.invoke({ capability: "health.check", input: {} })
    }
  };
}

function createUnavailableIgaHelpers() {
  const unavailable = async () => {
    throw igaError("RUNTIME_IGA_CLIENT_UNAVAILABLE", "runtime IGA client is not configured");
  };

  return {
    riskScores: { recompute: unavailable },
    health: { check: unavailable },
    get: unavailable,
    post: unavailable
  };
}

function igaError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
