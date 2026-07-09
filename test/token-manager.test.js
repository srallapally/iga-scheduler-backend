import { describe, expect, it, vi } from "vitest";
import { TokenManager } from "../src/iga/tokenManager.js";

describe("TokenManager", () => {
    it("caches token until it is near expiration", async () => {
        let now = 1_000_000;

        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                access_token: "token-1",
                token_type: "Bearer",
                expires_in: 300
            })
        });

        const manager = new TokenManager({
            tokenEndpoint: "https://example.com/oauth/token",
            clientId: "client",
            clientSecret: "secret",
            refreshSkewSeconds: 60,
            fetchImpl,
            now: () => now
        });

        const first = await manager.getAccessToken();
        const second = await manager.getAccessToken();

        expect(first).toBe("token-1");
        expect(second).toBe("token-1");
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("passes an abort signal to token request", async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                access_token: "token-1",
                expires_in: 300
            })
        });

        const manager = new TokenManager({
            tokenEndpoint: "https://example.com/oauth/token",
            clientId: "client",
            clientSecret: "secret",
            requestTimeoutMs: 1234,
            fetchImpl
        });

        await manager.getAccessToken();

        expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    });

    it("refreshes token when near expiration", async () => {
        let now = 1_000_000;

        const fetchImpl = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    access_token: "token-1",
                    expires_in: 300
                })
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    access_token: "token-2",
                    expires_in: 300
                })
            });

        const manager = new TokenManager({
            tokenEndpoint: "https://example.com/oauth/token",
            clientId: "client",
            clientSecret: "secret",
            refreshSkewSeconds: 60,
            fetchImpl,
            now: () => now
        });

        expect(await manager.getAccessToken()).toBe("token-1");

        now += 260_000;

        expect(await manager.getAccessToken()).toBe("token-2");
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("falls back to default expiration for malformed expires_in", async () => {
        let now = 1_000_000;

        const fetchImpl = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    access_token: "token-1",
                    expires_in: "forever"
                })
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    access_token: "token-2",
                    expires_in: 300
                })
            });

        const manager = new TokenManager({
            tokenEndpoint: "https://example.com/oauth/token",
            clientId: "client",
            clientSecret: "secret",
            refreshSkewSeconds: 60,
            fetchImpl,
            now: () => now
        });

        expect(await manager.getAccessToken()).toBe("token-1");

        now += 260_000;

        expect(await manager.getAccessToken()).toBe("token-2");
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("falls back to default expiration for non-positive expires_in", async () => {
        let now = 1_000_000;

        const fetchImpl = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    access_token: "token-1",
                    expires_in: 0
                })
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    access_token: "token-2",
                    expires_in: 300
                })
            });

        const manager = new TokenManager({
            tokenEndpoint: "https://example.com/oauth/token",
            clientId: "client",
            clientSecret: "secret",
            refreshSkewSeconds: 60,
            fetchImpl,
            now: () => now
        });

        expect(await manager.getAccessToken()).toBe("token-1");

        now += 260_000;

        expect(await manager.getAccessToken()).toBe("token-2");
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("invalidates cached token", async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    access_token: "token-1",
                    expires_in: 300
                })
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    access_token: "token-2",
                    expires_in: 300
                })
            });

        const manager = new TokenManager({
            tokenEndpoint: "https://example.com/oauth/token",
            clientId: "client",
            clientSecret: "secret",
            fetchImpl
        });

        expect(await manager.getAccessToken()).toBe("token-1");

        manager.invalidate();

        expect(await manager.getAccessToken()).toBe("token-2");
    });
});
