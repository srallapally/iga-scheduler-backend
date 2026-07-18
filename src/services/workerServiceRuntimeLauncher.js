const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";
const TOKEN_REFRESH_SKEW_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class WorkerServiceRuntimeLauncher {
  constructor({
    workerUrl = process.env.RUNTIME_WORKER_URL,
    runtimeServiceAccount = process.env.RUNTIME_SERVICE_ACCOUNT_EMAIL,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    fetchImpl = fetch,
    now = () => new Date()
  } = {}) {
    if (!workerUrl) throw new Error("RUNTIME_WORKER_URL is required");
    if (!runtimeServiceAccount) throw new Error("RUNTIME_SERVICE_ACCOUNT_EMAIL is required");
    this.workerUrl = workerUrl.replace(/\/+$/, "");
    this.runtimeServiceAccount = runtimeServiceAccount;
    this.requestTimeoutMs = requestTimeoutMs;
    this._fetch = fetchImpl;
    this.now = now;
    this._cachedToken = null; // { token, expiresAtMs }
  }

  async launchExecution({ runId, dispatchId, execution, context }) {
    const token = await this._getToken();
    return this._launch({ runId, dispatchId, execution, context }, token, true);
  }

  async _launch({ runId, dispatchId, execution, context }, token, retryOn401) {
    const res = await this._fetch(`${this.workerUrl}/execute`, {
      method: "POST",
      signal: AbortSignal.timeout(this.requestTimeoutMs),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ runId, dispatchId, execution, context })
    });

    if (res.status === 401 && retryOn401) {
      this._cachedToken = null;
      const freshToken = await this._getToken();
      return this._launch({ runId, dispatchId, execution, context }, freshToken, false);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`worker /execute failed: HTTP ${res.status} ${text}`);
    }

    return {
      backend: "worker-service",
      workerUrl: this.workerUrl,
      runtimeServiceAccount: this.runtimeServiceAccount,
      launchedAt: this.now().toISOString()
    };
  }

  async cancel() {
    return { status: "unsupported" };
  }

  async getStatus() {
    return { status: "unsupported" };
  }

  async _getToken() {
    const now = Date.now();
    if (this._cachedToken && this._cachedToken.expiresAtMs - now > TOKEN_REFRESH_SKEW_MS) {
      return this._cachedToken.token;
    }
    const token = await this._fetchOidcToken();
    const expiresAtMs = parseJwtExp(token) ?? now + 3_600_000;
    this._cachedToken = { token, expiresAtMs };
    return token;
  }

  async _fetchOidcToken() {
    const url = `${METADATA_TOKEN_URL}?audience=${encodeURIComponent(this.workerUrl)}&format=full`;
    const res = await this._fetch(url, {
      signal: AbortSignal.timeout(this.requestTimeoutMs),
      headers: { "Metadata-Flavor": "Google" }
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OIDC token fetch failed for worker service: HTTP ${res.status} ${text}`);
    }
    return res.text();
  }
}

function parseJwtExp(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}
