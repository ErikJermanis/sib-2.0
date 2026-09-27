import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkReleaseAge, lockedVersions } from "./check-dependency-age.mjs";

const now = Date.parse("2026-09-27T12:00:00Z");
const entry = (name, version) => ({
  version,
  resolved: `https://registry.npmjs.org/${encodeURIComponent(name)}/-/${name.split("/").at(-1)}-${version}.tgz`,
  integrity: "sha512-example",
});
const lock = (packages) => ({ lockfileVersion: 3, packages: { "": { version: "1.0.0" }, ...packages } });
const registry = (timestamps, calls) => async (url) => {
  calls.push(decodeURIComponent(new URL(url).pathname.slice(1)));
  return { ok: true, json: async () => ({ time: timestamps }) };
};

test("checks nested and scoped lockfile packages once per name", async () => {
  const calls = [];
  const snapshot = lock({
    "node_modules/@acme/widget": entry("@acme/widget", "1.0.0"),
    "node_modules/other/node_modules/@acme/widget": entry("@acme/widget", "1.0.0"),
  });
  const count = await checkReleaseAge(snapshot, {
    now,
    fetchImpl: registry({ "1.0.0": "2026-09-13T12:00:00Z" }, calls),
  });
  assert.equal(count, 1);
  assert.deepEqual(calls, ["@acme/widget"]);
});

test("refuses a pinned release younger than fourteen days", async () => {
  const snapshot = lock({ "node_modules/example": entry("example", "2.0.0") });
  await assert.rejects(
    checkReleaseAge(snapshot, {
      now,
      fetchImpl: registry({ "2.0.0": "2026-09-14T12:00:00Z" }, []),
    }),
    /younger than 14 days:[\s\S]*example@2\.0\.0/,
  );
});

test("fails closed if publish dates or registry metadata are unavailable", async () => {
  const snapshot = lock({ "node_modules/example": entry("example", "2.0.0") });
  await assert.rejects(checkReleaseAge(snapshot, { now, fetchImpl: registry({}, []) }), /missing publish time/);
  await assert.rejects(
    checkReleaseAge(snapshot, { now, fetchImpl: async () => ({ ok: false, status: 503 }) }),
    /HTTP 503/,
  );
});

test("rejects non-registry or unhashed lockfile entries", () => {
  assert.throws(() => lockedVersions(lock({
    "node_modules/example": { ...entry("example", "1.0.0"), resolved: "https://elsewhere.test/example.tgz" },
  })), /expected a registry tarball/);
  assert.throws(() => lockedVersions(lock({
    "node_modules/example": { ...entry("example", "1.0.0"), integrity: undefined },
  })), /integrity hash/);
});

test("every dependency in the committed lockfile can be checked", () => {
  const committed = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.ok(lockedVersions(committed).size > 0);
});
