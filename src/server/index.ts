import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

export { buildServer, createServer } from "./server.js";

export async function startServer(): Promise<void> {
  const config = loadConfig();
  const app = buildServer({ config });
  let closing = false;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "shutting down");
    await app.close();
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    app.log.error(error);
    await app.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch(() => {
    process.exitCode = 1;
  });
}
