import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env";
import { isDatabaseConnected } from "./config/db";
import { errorHandler, notFound } from "./middleware/errorHandler";
import { globalLimiter, pingLimiter } from "./middleware/rateLimiters";
import v1Routes from "./routes";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  if (env.TRUST_PROXY > 0) app.set("trust proxy", env.TRUST_PROXY);

  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => {
        // No Origin header = curl / server-to-server / same-origin: allow. Browsers are checked against the allow-list.
        if (!origin || env.clientOrigins.includes(origin)) return cb(null, true);
        cb(null, false);
      },
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Attendance-Device"],
      maxAge: 600,
    }),
  );
  if (env.NODE_ENV !== "test") app.use(morgan(env.isProduction ? "combined" : "dev"));
  app.use(express.json({ limit: "100kb" }));

  // Connectivity probe for the frontend's "no network / unstable network" banner. Deliberately BEFORE the global limiter: it does no work (no
  // database, no auth), and behind a campus NAT hundreds of students share one IP, so counting probes would lock people out of the real API.
  // Capped far above any sane use only to blunt a flood.
  app.all("/api/v1/ping", pingLimiter, (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") return void res.status(405).set("Allow", "GET, HEAD").end();
    res.set("Cache-Control", "no-store").status(204).end(); // 204: nothing to download, so the measured time is the network round trip
  });
  app.use(globalLimiter);

  app.get("/health", (_req, res) => {
    const db = isDatabaseConnected();
    res.status(db ? 200 : 503).json({
      success: db,
      status: db ? "ok" : "degraded",
      database: db ? "connected" : "disconnected",
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  app.use("/api/v1", v1Routes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
