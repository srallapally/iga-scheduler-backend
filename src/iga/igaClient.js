export class IgaClient {
    constructor({
                    baseUrl,
                    tokenManager,
                    requestTimeoutMs = 10_000,
                    fetchImpl = fetch
                }) {
        if (!baseUrl) throw new Error("baseUrl is required");
        if (!tokenManager) throw new Error("tokenManager is required");

        this.baseUrl = baseUrl.replace(/\/$/, "");
        this.tokenManager = tokenManager;
        this.requestTimeoutMs = requestTimeoutMs;
        this.fetchImpl = fetchImpl;

        this.riskScores = {
            recompute: (input) => this.post("/scheduler/risk-scores/recompute", input)
        };

        this.health = {
            check: () => this.get("/info/ping")
        };
    }

    async get(path) {
        return this.request("GET", path);
    }

    async post(path, body) {
        return this.request("POST", path, body);
    }

    async put(path, body) {
        return this.request("PUT", path, body);
    }

    async patch(path, body) {
        return this.request("PATCH", path, body);
    }

    async delete(path) {
        return this.request("DELETE", path);
    }

    async request(method, path, body, retryOn401 = true) {
        const token = await this.tokenManager.getAccessToken();

        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
            method,
            signal: AbortSignal.timeout(this.requestTimeoutMs),
            headers: {
                "Authorization": `Bearer ${token}`,
                "Accept": "application/json",
                ...(body !== undefined && body !== null ? { "Content-Type": "application/json" } : {})
            },
            ...(body !== undefined && body !== null ? { body: JSON.stringify(body) } : {})
        });

        if (response.status === 401 && retryOn401) {
            this.tokenManager.invalidate();
            return this.request(method, path, body, false);
        }

        const text = await response.text();

        if (!response.ok) {
            throw new Error(`IGA request failed: ${method} ${path} HTTP ${response.status} ${text}`);
        }

        return text ? JSON.parse(text) : {};
    }
}
