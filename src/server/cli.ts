import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import {
  createPairingToken,
  listDevices,
  openDatabase,
  revokeDevice,
} from "./database.js";

const USAGE = `Usage:
  npm run app -- create-pairing-link --name <device name>
  npm run app -- create-pairing-link <device name>
  npm run app -- list-devices
  npm run app -- revoke-device <id>`;

export function runCli(args: string[] = process.argv.slice(2)): void {
  const [command, ...commandArgs] = args;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }

  const config = loadConfig();
  const database = openDatabase(config.databasePath);
  try {
    if (command === "create-pairing-link") {
      const name = pairingName(commandArgs);
      const token = createPairingToken(database, name);
      console.log(`${config.publicBaseUrl}/pair/${token}`);
      return;
    }

    if (command === "list-devices") {
      if (commandArgs.length !== 0) fail("list-devices does not accept arguments");
      const devices = listDevices(database);
      if (devices.length === 0) {
        console.log("No devices found.");
        return;
      }
      for (const device of devices) {
        const status = device.revokedAt ? `revoked ${device.revokedAt}` : "active";
        console.log(
          `${device.id}\t${device.name}\t${status}\tlast seen ${device.lastSeenAt ?? "never"}`,
        );
      }
      return;
    }

    if (command === "revoke-device") {
      if (commandArgs.length !== 1) fail("revoke-device requires exactly one device id");
      const id = commandArgs[0];
      if (!id || !revokeDevice(database, id)) fail(`No device found with id ${JSON.stringify(id)}`);
      console.log(`Revoked device ${id}.`);
      return;
    }

    fail(`Unknown command ${JSON.stringify(command)}`);
  } finally {
    database.close();
  }
}

function pairingName(args: string[]): string {
  let name: string;
  if (args[0] === "--name") {
    if (args.length !== 2) fail("--name requires one quoted device name");
    name = args[1] ?? "";
  } else {
    name = args.join(" ");
  }

  name = name.trim();
  if (!name) fail("A device name is required");
  if (name.length > 200) fail("Device name must be at most 200 characters");
  return name;
}

function fail(message: string): never {
  throw new CliError(`${message}\n\n${USAGE}`);
}

class CliError extends Error {}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
