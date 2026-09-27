#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const minimumAgeDays = 14;
const minimumNpmVersion = [11, 19];

function assertNpmConfiguration() {
  const version = execFileSync("npm", ["--version"], { cwd: projectRoot, encoding: "utf8" }).trim();
  const [major, minor] = version.split(".").map(Number);
  if (major < minimumNpmVersion[0] ||
      (major === minimumNpmVersion[0] && minor < minimumNpmVersion[1]) ||
      !Number.isInteger(major) || !Number.isInteger(minor)) {
    throw new Error(`npm >=11.19 is required for min-release-age (found ${version})`);
  }
  const age = execFileSync("npm", ["config", "get", "min-release-age"], {
    cwd: projectRoot, encoding: "utf8",
  }).trim();
  if (age !== String(minimumAgeDays)) {
    throw new Error(`expected min-release-age=${minimumAgeDays} in the project's npm configuration (found ${age})`);
  }
}

export function lockedVersions(lock) {
  if (lock.lockfileVersion !== 3 || !lock.packages) {
    throw new Error("expected a version 3 package-lock.json with a packages map");
  }
  const versions = new Map();
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location) continue; // Project root, not an npm dependency.
    const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(location);
    if (!match || !entry?.version || typeof entry.version !== "string") {
      throw new Error(`cannot check lockfile entry ${location}`);
    }
    const name = entry.name ?? match[1];
    if (!entry.resolved?.startsWith("https://registry.npmjs.org/") || !entry.integrity) {
      throw new Error(`cannot verify ${location}: expected a registry tarball with an integrity hash`);
    }
    if (!versions.has(name)) versions.set(name, new Set());
    versions.get(name).add(entry.version);
  }
  return versions;
}

export async function checkReleaseAge(lock, { fetchImpl = fetch, now = Date.now() } = {}) {
  const versions = [...lockedVersions(lock)];
  const cutoff = now - minimumAgeDays * 24 * 60 * 60 * 1000;
  const tooRecent = [];
  let next = 0;

  async function worker() {
    while (next < versions.length) {
      const [name, pinned] = versions[next++];
      const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
      const response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`registry lookup for ${name} failed: HTTP ${response.status}`);
      const metadata = await response.json();
      for (const version of pinned) {
        const published = metadata.time?.[version];
        const timestamp = Date.parse(published);
        if (!Number.isFinite(timestamp)) {
          throw new Error(`missing publish time for ${name}@${version}; refusing to install`);
        }
        if (timestamp > cutoff) tooRecent.push(`${name}@${version} (published ${published})`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(8, versions.length) }, worker));
  if (tooRecent.length) {
    throw new Error(`lockfile contains releases younger than ${minimumAgeDays} days:\n${tooRecent.sort().join("\n")}`);
  }
  return [...versions].reduce((total, [, pinned]) => total + pinned.size, 0);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    assertNpmConfiguration();
    const lock = JSON.parse(readFileSync(resolve(projectRoot, "package-lock.json"), "utf8"));
    const count = await checkReleaseAge(lock);
    console.log(`Checked ${count} pinned package versions: all are at least ${minimumAgeDays} days old.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
