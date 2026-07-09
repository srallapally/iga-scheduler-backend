import express from "express";
import { TokenManager } from "../iga/tokenManager.js";
import { IgaClient } from "../iga/igaClient.js";
import { createInternalAuthMiddleware } from "../middleware/internalAuth.js";

export function createInternalIgaRouter(options = {}) {
    const router = express.Router();
    const authMiddleware = options.authMiddleware || createInternalAuthMiddleware(options.auth || {});

    const tokenManager = options.tokenManager || new TokenManager({
        tokenEndpoint: process.env.IGA_TOKEN_ENDPOINT,
        clientId: process.env.IGA_CLIENT_ID,
        clientSecret: process.env.IGA_CLIENT_SECRET,
        scope: process.env.IGA_TOKEN_SCOPE,
        refreshSkewSeconds: Number(process.env.IGA_TOKEN_REFRESH_SKEW_SECONDS || 60)
    });

    const igaClient = options.igaClient || new IgaClient({
        baseUrl: process.env.IGA_BASE_URL,
        tokenManager
    });

    router.use(authMiddleware);

    router.get("/health", async (_req, res) => {
        try {
            await tokenManager.getAccessToken();

            res.json({
                status: "ok",
                oauth: "ok",
                iga: "not_checked",
                message: "OAuth token acquisition succeeded. Configure IGA_HEALTH_PATH to validate an IGA API endpoint."
            });
        } catch {
            res.status(500).json({
                status: "error",
                oauth: "error",
                iga: "not_checked",
                message: "OAuth token acquisition failed"
            });
        }
    });
    router.get("/api-health", async (_req, res) => {
        const healthPath = process.env.IGA_HEALTH_PATH;

        if (!healthPath) {
            return res.status(400).json({
                status: "error",
                message: "IGA_HEALTH_PATH is not configured"
            });
        }

        try {
            const result = await igaClient.get(healthPath);

            res.json({
                status: "ok",
                oauth: "ok",
                iga: "ok",
                path: healthPath,
                result
            });
        } catch {
            res.status(500).json({
                status: "error",
                oauth: "ok",
                iga: "error",
                path: healthPath,
                message: "IGA API health check failed"
            });
        }
    });
    return router;
}
