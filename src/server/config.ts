export interface ServerConfig {
  host: string;
  port: number;
  databasePath: string;
  publicBaseUrl: string;
  nodeEnv: string;
}

export type ServerConfigOverrides = Partial<ServerConfig>;

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: ServerConfigOverrides = {},
): ServerConfig {
  const host = overrides.host ?? env.HOST ?? "127.0.0.1";
  const port = overrides.port ?? parsePort(env.PORT);
  const databasePath = overrides.databasePath ?? env.DATABASE_PATH ?? "./data/sib.sqlite";
  const nodeEnv = overrides.nodeEnv ?? env.NODE_ENV ?? "development";
  const publicBaseUrl = (
    overrides.publicBaseUrl ?? env.PUBLIC_BASE_URL ?? `http://${host}:${port}`
  ).replace(/\/+$/, "");

  if (!host) {
    throw new Error("HOST must not be empty");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT must be an integer between 1 and 65535, received ${JSON.stringify(port)}`);
  }
  if (!databasePath) {
    throw new Error("DATABASE_PATH must not be empty");
  }
  if (!publicBaseUrl) {
    throw new Error("PUBLIC_BASE_URL must not be empty");
  }

  return { host, port, databasePath, publicBaseUrl, nodeEnv };
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 3000;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT must be an integer between 1 and 65535, received ${JSON.stringify(value)}`);
  }
  return port;
}
