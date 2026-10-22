import { createApp } from "./app";
import { connectDatabase, disconnectDatabase } from "./config/db";
import { env } from "./config/env";
import { Department } from "./models/Department";
import { Student } from "./models/Student";
import { attachRealtime } from "./realtime/server";
import { quizService } from "./services/quiz";
import { shortSessionWarning } from "./utils/duration";
import { logger } from "./utils/logger";

async function main() {
  await connectDatabase();
  // Make sure unique indexes exist before accepting traffic.
  await Promise.all([Department.init(), Student.init()]);

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`API listening on port ${env.PORT} (${env.NODE_ENV})`);
  });

  const sessionWarning = shortSessionWarning(env.JWT_EXPIRES_IN);
  if (sessionWarning) logger.warn(sessionWarning);
  const realtime = attachRealtime(server);
  void quizService.resume().catch((err) => logger.error("Quiz resume failed:", err)); // re-arm the clock of any question that was running
  setInterval(() => { void quizService.sweepIdle().catch(() => undefined); }, 60_000).unref(); // cancel games the host abandoned // Socket.IO on the same port; null when SOCKET_ENABLED=false

  const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    const done = async () => {
      await disconnectDatabase();
      process.exit(0);
    };
    if (realtime) void realtime.close().then(done); // closes every socket and the HTTP server
    else server.close(done);
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

process.on("unhandledRejection", (reason) => logger.error("Unhandled rejection:", reason));

main().catch((err) => {
  logger.error("Failed to start server:", err);
  process.exit(1);
});
