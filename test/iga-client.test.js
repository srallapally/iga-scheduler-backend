import { describe, expect, it, vi } from "vitest";
import { IgaClient } from "../src/iga/igaClient.js";

describe("IgaClient", () => {
    it("passes an abort signal to IGA API requests", async () => {
        const tokenManager = {
            getAccessToken: vi.fn(async () => "access-token"),
            invalidate: vi.fn()
        };
        const fetchImpl = vi.fn(async () => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ ok: true })
        }));

        const client = new IgaClient({
            baseUrl: "https://iga.example.test/",
            tokenManager,
            requestTimeoutMs: 1234,
            fetchImpl
        });

        const result = await client.get("/info/ping");

        expect(result).toEqual({ ok: true });
        expect(fetchImpl).toHaveBeenCalledWith("https://iga.example.test/info/ping", expect.objectContaining({
            method: "GET",
            signal: expect.any(AbortSignal)
        }));
    });

    it("invalidates token and retries once on 401", async () => {
        const tokenManager = {
            getAccessToken: vi.fn()
                .mockResolvedValueOnce("token-1")
                .mockResolvedValueOnce("token-2"),
            invalidate: vi.fn()
        };
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 401,
                text: async () => "unauthorized"
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ ok: true })
            });

        const client = new IgaClient({
            baseUrl: "https://iga.example.test",
            tokenManager,
            fetchImpl
        });

        await expect(client.get("/info/ping")).resolves.toEqual({ ok: true });
        expect(tokenManager.invalidate).toHaveBeenCalledTimes(1);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
});
