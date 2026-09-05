import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import type Database from "better-sqlite3";
import type { SessionResponse, SyncResponse } from "../shared/protocol.js";
import { loadConfig, type ServerConfigOverrides } from "./config.js";
import {
  consumePairingToken,
  findDeviceBySessionHash,
  FutureCursorError,
  openDatabase,
  processSync,
  touchDevice,
  type DeviceRecord,
} from "./database.js";
import { hashToken } from "./security.js";
import { validateSyncRequest, ValidationError } from "./validation.js";

const SESSION_COOKIE = "sib_session";
const PAIRING_ERROR_HTML = `<!doctype html>
<html lang="hr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nevažeća poveznica</title></head>
<body><main><h1>Poveznica više nije valjana</h1><p>Ova poveznica za uparivanje je nevažeća ili je već iskorištena.</p></main></body>
</html>`;

export interface BuildServerOptions extends ServerConfigOverrides {
  config?: ServerConfigOverrides;
  database?: Database.Database;
  env?: NodeJS.ProcessEnv;
  logger?: FastifyServerOptions["logger"];
  staticRoot?: string;
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const directOverrides: ServerConfigOverrides = {
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.databasePath !== undefined ? { databasePath: options.databasePath } : {}),
    ...(options.publicBaseUrl !== undefined ? { publicBaseUrl: options.publicBaseUrl } : {}),
    ...(options.nodeEnv !== undefined ? { nodeEnv: options.nodeEnv } : {}),
  };
  const config = loadConfig(options.env, { ...directOverrides, ...options.config });
  const database = options.database ?? openDatabase(config.databasePath);
  const ownsDatabase = options.database === undefined;
  const app = Fastify({
    logger: options.logger ?? config.nodeEnv !== "test",
    bodyLimit: 1_048_576,
  });

  app.addHook("onSend", async (_request, reply) => {
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; img-src 'self' data:; manifest-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'; worker-src 'self'",
    );
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (config.nodeEnv === "production") {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  });

  app.register(cookie);

  app.get("/api/health", async () => ({ ok: true }));

  app.get<{ Reply: SessionResponse | { error: string } }>("/api/session", async (request, reply) => {
    const device = authenticate(database, request.cookies[SESSION_COOKIE]);
    if (!device) {
      return reply.code(401).send({ authenticated: false });
    }
    touchDevice(database, device.id);
    return { authenticated: true, deviceName: device.name };
  });

  app.post<{ Reply: SyncResponse | { error: string } }>("/api/sync", async (request, reply) => {
    const device = authenticate(database, request.cookies[SESSION_COOKIE]);
    if (!device) {
      return reply.code(401).send({ error: "Authentication required" });
    }

    try {
      const syncRequest = validateSyncRequest(request.body);
      return processSync(database, device.id, syncRequest.operations, syncRequest.lastSyncVersion);
    } catch (error) {
      if (error instanceof ValidationError || error instanceof FutureCursorError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get<{ Params: { token: string } }>("/pair/:token", async (request, reply) => {
    const paired = consumePairingToken(database, hashToken(request.params.token));
    if (!paired) {
      return reply.code(410).type("text/html; charset=utf-8").send(PAIRING_ERROR_HTML);
    }

    reply.setCookie(SESSION_COOKIE, paired.sessionToken, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 315_360_000,
      secure: config.nodeEnv === "production",
    });
    return reply.redirect("/shopping");
  });

  if (config.nodeEnv === "production") {
    app.register(fastifyStatic, {
      root: options.staticRoot ?? path.resolve(process.cwd(), "dist", "client"),
      setHeaders(response, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          response.header("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          response.header("Cache-Control", "no-cache");
        }
      },
    });
    for (const route of ["/", "/shopping", "/travel"] as const) {
      app.get(route, async (_request, reply) => reply.sendFile("index.html"));
    }
  }

  if (ownsDatabase) {
    app.addHook("onClose", async () => {
      database.close();
    });
  }

  return app;
}

export const createServer = buildServer;

function authenticate(
  database: Database.Database,
  rawSessionToken: string | undefined,
): DeviceRecord | null {
  // Hash even a missing token so unauthenticated requests follow the same lookup path.
  return findDeviceBySessionHash(database, hashToken(rawSessionToken ?? ""));
}
