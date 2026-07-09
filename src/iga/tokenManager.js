export class TokenManager {
    constructor({
                    tokenEndpoint,
                    clientId,
                    clientSecret,
                    scope,
                    refreshSkewSeconds = 60,
                    requestTimeoutMs = 10_000,
                    fetchImpl = fetch,
                    now = () => Date.now()
                }) {
        if (!tokenEndpoint) throw new Error("tokenEndpoint is required");
        if (!clientId) throw new Error("clientId is required");
        if (!clientSecret) throw new Error("clientSecret is required");

        this.tokenEndpoint = tokenEndpoint;
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.scope = scope;
        this.refreshSkewMs = refreshSkewSeconds * 1000;
        this.requestTimeoutMs = requestTimeoutMs;
        this.fetchImpl = fetchImpl;
        this.now = now;

        this.cachedToken = null;
        this.inFlightRefresh = null;
    }

    async getAccessToken() {
        if (this.cachedToken && !this.isExpiringSoon(this.cachedToken)) {
            return this.cachedToken.accessToken;
        }

        if (!this.inFlightRefresh) {
            this.inFlightRefresh = this.fetchToken()
                .finally(() => {
                    this.inFlightRefresh = null;
                });
        }

        const token = await this.inFlightRefresh;
        this.cachedToken = token;
        return token.accessToken;
    }

    invalidate() {
        this.cachedToken = null;
    }

    isExpiringSoon(token) {
        return token.expiresAtMs - this.now() <= this.refreshSkewMs;
    }

    async fetchToken() {
        const body = new URLSearchParams();
        body.set("grant_type", "client_credentials");

        if (this.scope) {
            body.set("scope", this.scope);
        }

        const basic = Buffer
            .from(`${this.clientId}:${this.clientSecret}`, "utf8")
            .toString("base64");

        const response = await this.fetchImpl(this.tokenEndpoint, {
            method: "POST",
            signal: AbortSignal.timeout(this.requestTimeoutMs),
            headers: {
                "Authorization": `Basic ${basic}`,
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json"
            },
            body
        });

        const text = await response.text();

        if (!response.ok) {
            throw new Error(`OAuth token request failed: HTTP ${response.status} ${text}`);
        }

        const json = JSON.parse(text);

        if (!json.access_token) {
            throw new Error("OAuth token response missing access_token");
        }

        const rawExpiresInSeconds = Number(json.expires_in);
        const expiresInSeconds = Number.isFinite(rawExpiresInSeconds) && rawExpiresInSeconds > 0
            ? rawExpiresInSeconds
            : 300;

        return {
            accessToken: json.access_token,
            tokenType: json.token_type || "Bearer",
            expiresAtMs: this.now() + expiresInSeconds * 1000
        };
    }
}
