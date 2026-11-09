#!/usr/bin/env node
// App Store Connect API client for the shell pipeline. No dependencies, Node 22+.
//
//   node generator/asc.mjs ensure-bundle-id --bundle-id cloud.x.y --name "App Name"
//   node generator/asc.mjs app-id --bundle-id cloud.x.y
//   node generator/asc.mjs next-build --bundle-id cloud.x.y [--fallback N]
//   node generator/asc.mjs wait-build --bundle-id cloud.x.y --build N [--timeout-minutes 20]
//   node generator/asc.mjs add-to-group --bundle-id cloud.x.y --build N --group "Group Name"
//   node generator/asc.mjs expire-build --bundle-id cloud.x.y --build N
//   node generator/asc.mjs info --bundle-id cloud.x.y
//   node generator/asc.mjs builds --bundle-id cloud.x.y
//   node generator/asc.mjs selftest
//
// Env: ASC_KEY_ID, ASC_ISSUER_ID, and the private key as ASC_KEY_PATH (a .p8 file) or
// ASC_KEY_P8_B64 (base64 of the file). APPLE_TEAM_ID is accepted for symmetry with the CI and
// not used by any call here. The key must be an Admin key for cloud signing elsewhere; every
// call in this file works with App Manager too.
//
// Exit codes: 0 ok, 1 error (API or usage), 3 a manual step is required (the app record does
// not exist in App Store Connect; the public API has no endpoint to create one).
//
// next-build prints only a number so the CI can capture it: the fallback (or 1) when the app has
// no build yet or no app record, otherwise max(highest build number ever, fallback) + 1.

import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API = "https://api.appstoreconnect.apple.com";
const EXIT_MANUAL_STEP = 3;

// ---------- CLI ----------
export function parseArgs(argv) {
  const flags = {};
  let command = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { if (command === null) command = a; continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true;
    else { flags[key] = next; i++; }
  }
  return { command, flags };
}

// ---------- Auth ----------
const b64url = (input) => Buffer.from(typeof input === "string" ? input : JSON.stringify(input)).toString("base64url");

export function buildJwt({ keyId, issuerId, pem, now = Math.floor(Date.now() / 1000) }) {
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const payload = { iss: issuerId, iat: now, exp: now + 15 * 60, aud: "appstoreconnect-v1" };
  const unsigned = `${b64url(header)}.${b64url(payload)}`;
  const signature = sign("sha256", Buffer.from(unsigned), { key: createPrivateKey(pem), dsaEncoding: "ieee-p1363" });
  return `${unsigned}.${signature.toString("base64url")}`;
}

function keyPem() {
  if (process.env.ASC_KEY_PATH) return readFileSync(process.env.ASC_KEY_PATH, "utf8");
  if (process.env.ASC_KEY_P8_B64) {
    const dir = mkdtempSync(join(tmpdir(), "asc-"));
    const file = join(dir, "AuthKey.p8");
    writeFileSync(file, Buffer.from(process.env.ASC_KEY_P8_B64, "base64"), { mode: 0o600 });
    return readFileSync(file, "utf8");
  }
  return fail("Set ASC_KEY_PATH (a .p8 file) or ASC_KEY_P8_B64.");
}

let cachedJwt = null;
function jwt() {
  if (cachedJwt) return cachedJwt;
  const keyId = process.env.ASC_KEY_ID;
  const issuerId = process.env.ASC_ISSUER_ID;
  if (!keyId || !issuerId) fail("Set ASC_KEY_ID and ASC_ISSUER_ID.");
  cachedJwt = buildJwt({ keyId, issuerId, pem: keyPem() });
  return cachedJwt;
}

// ---------- HTTP ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, { allow = [] } = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${jwt()}`, "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : null;
    if (allow.includes(res.status)) return { status: res.status, errorText: text };
    if (attempt === 1 && (res.status === 429 || res.status >= 500)) { await sleep(5000); continue; }
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 600)}`);
  }
}

// ---------- Resources ----------
async function findBundleId(identifier) {
  const r = await api("GET", `/v1/bundleIds?filter[identifier]=${encodeURIComponent(identifier)}&fields[bundleIds]=identifier,name`);
  return r.data.find((b) => b.attributes.identifier === identifier) || null;
}

async function findApp(bundleId) {
  const r = await api("GET", `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&fields[apps]=name,bundleId`);
  return r.data.find((a) => a.attributes.bundleId === bundleId) || null;
}

function requireApp(app, bundleId) {
  if (app) return app;
  console.error(`[asc] No app record for ${bundleId} in App Store Connect. The public API cannot create one:`);
  console.error(`[asc] open App Store Connect > My Apps > + > New App, platform iOS, pick the bundle id ${bundleId}, SKU = the bundle id. Then run again.`);
  return process.exit(EXIT_MANUAL_STEP);
}

async function latestBuild(appId) {
  const r = await api("GET", `/v1/builds?filter[app]=${appId}&sort=-uploadedDate&limit=1&fields[builds]=version,processingState,uploadedDate`);
  return r.data[0] || null;
}

// The highest build number the app ever had, whatever its upload date: a build uploaded later
// with a lower number (a parallel train, a run-number fallback) must not pull the counter back.
async function highestBuildNumber(appId) {
  const r = await api("GET", `/v1/builds?filter[app]=${appId}&limit=200&fields[builds]=version`);
  const numbers = r.data.map((b) => Number.parseInt(String(b.attributes.version), 10)).filter((n) => !Number.isNaN(n));
  return numbers.length ? String(Math.max(...numbers)) : null;
}

async function buildByNumber(appId, build) {
  const r = await api("GET", `/v1/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(build)}&fields[builds]=version,processingState`);
  return r.data.find((b) => String(b.attributes.version) === String(build)) || null;
}

async function betaGroups(appId) {
  const r = await api("GET", `/v1/apps/${appId}/betaGroups?fields[betaGroups]=name,isInternalGroup&limit=200`);
  return r.data;
}

export function nextBuildNumber(latestVersion, fallback) {
  const fb = Math.max(Number.parseInt(fallback ?? "1", 10) || 1, 1);
  if (latestVersion === null || latestVersion === undefined) return fb;
  const latest = Number.parseInt(String(latestVersion), 10);
  if (Number.isNaN(latest)) return fb;
  return Math.max(latest, fb) + 1;
}

// ---------- Commands ----------
const commands = {
  async "ensure-bundle-id"({ "bundle-id": bundleId, name }) {
    need({ bundleId, name });
    let b = await findBundleId(bundleId);
    if (!b) {
      const r = await api("POST", "/v1/bundleIds", { data: { type: "bundleIds", attributes: { identifier: bundleId, name, platform: "IOS" } } });
      b = r.data;
      console.error(`[asc] registered bundle id ${bundleId} (${b.id})`);
    }
    console.log(b.id);
  },

  async "app-id"({ "bundle-id": bundleId }) {
    need({ bundleId });
    console.log(requireApp(await findApp(bundleId), bundleId).id);
  },

  async "next-build"({ "bundle-id": bundleId, fallback }) {
    need({ bundleId });
    const app = await findApp(bundleId);
    if (!app) {
      console.error(`[asc] no app record for ${bundleId} yet; using the fallback build number`);
      console.log(nextBuildNumber(null, fallback));
      return;
    }
    console.log(nextBuildNumber(await highestBuildNumber(app.id), fallback));
  },

  async "wait-build"({ "bundle-id": bundleId, build, "timeout-minutes": timeoutMinutes }) {
    need({ bundleId, build });
    const app = requireApp(await findApp(bundleId), bundleId);
    const deadline = Date.now() + (Number(timeoutMinutes) || 20) * 60_000;
    for (;;) {
      const b = await buildByNumber(app.id, build);
      const state = b ? b.attributes.processingState : "NOT_UPLOADED_YET";
      if (state === "VALID") { console.log(b.id); return; }
      if (state === "FAILED" || state === "INVALID") fail(`build ${build} ended in ${state}`);
      if (Date.now() > deadline) fail(`build ${build} still ${state} after the timeout`);
      console.error(`[asc] build ${build} is ${state}; waiting 30 s`);
      await sleep(30_000);
    }
  },

  async "add-to-group"({ "bundle-id": bundleId, build, group }) {
    need({ bundleId, build, group });
    const app = requireApp(await findApp(bundleId), bundleId);
    const b = await buildByNumber(app.id, build);
    if (!b) fail(`build ${build} not found for ${bundleId}; run wait-build first`);
    let g = (await betaGroups(app.id)).find((x) => x.attributes.name === group);
    if (!g) {
      const r = await api("POST", "/v1/betaGroups", {
        data: { type: "betaGroups", attributes: { name: group, isInternalGroup: false }, relationships: { app: { data: { type: "apps", id: app.id } } } },
      });
      g = r.data;
      console.error(`[asc] created beta group "${group}" (${g.id})`);
    }
    const r = await api("POST", `/v1/betaGroups/${g.id}/relationships/builds`, { data: [{ type: "builds", id: b.id }] }, { allow: [409, 422] });
    if (r && r.status === 409 && !/already/i.test(r.errorText)) throw new Error(`adding build to group -> 409: ${r.errorText.slice(0, 600)}`);
    if (r && r.status === 422) {
      // An internal group (App Store Connect users) receives every processed build by itself and
      // refuses explicit assignment; nothing to do.
      if (!/internal group/i.test(r.errorText)) throw new Error(`adding build to group -> 422: ${r.errorText.slice(0, 600)}`);
      console.error(`[asc] "${group}" is an internal group: it receives every build automatically`);
    }
    console.log(JSON.stringify({ group: g.id, build: b.id }));
  },

  // Expire a build number in TestFlight (every build carrying it, when an upload was repeated),
  // so testers stop seeing a binary that should not be installed.
  async "expire-build"({ "bundle-id": bundleId, build }) {
    need({ bundleId, build });
    const app = requireApp(await findApp(bundleId), bundleId);
    const r = await api("GET", `/v1/builds?filter[app]=${app.id}&filter[version]=${encodeURIComponent(build)}&fields[builds]=version,expired`);
    const targets = r.data.filter((b) => String(b.attributes.version) === String(build) && !b.attributes.expired);
    if (targets.length === 0) fail(`no unexpired build ${build} for ${bundleId}`);
    for (const b of targets) {
      await api("PATCH", `/v1/builds/${b.id}`, { data: { type: "builds", id: b.id, attributes: { expired: true } } });
      console.error(`[asc] build ${build} (${b.id}) expired`);
    }
    console.log(JSON.stringify({ build, expired: targets.map((b) => b.id) }));
  },

  // Every build the API lists for the app, newest first: what next-build chooses from.
  async builds({ "bundle-id": bundleId }) {
    need({ bundleId });
    const app = requireApp(await findApp(bundleId), bundleId);
    const r = await api("GET", `/v1/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=50&fields[builds]=version,processingState,uploadedDate,expired,usesNonExemptEncryption,betaGroups,iconAssetToken&include=preReleaseVersion&fields[preReleaseVersions]=version`);
    const trains = Object.fromEntries((r.included || []).map((i) => [i.id, i.attributes.version]));
    const rows = r.data.map((b) => ({ build: b.attributes.version, train: trains[b.relationships?.preReleaseVersion?.data?.id] ?? null, state: b.attributes.processingState, expired: b.attributes.expired, uploaded: b.attributes.uploadedDate, encryption: b.attributes.usesNonExemptEncryption, groups: (b.relationships?.betaGroups?.data || []).length, icon: b.attributes.iconAssetToken ? "yes" : "none" }));
    console.log(JSON.stringify(rows, null, 2));
  },

  async info({ "bundle-id": bundleId }) {
    need({ bundleId });
    const app = await findApp(bundleId);
    if (!app) { console.log(JSON.stringify({ appId: null, bundleId })); return; }
    const latest = await latestBuild(app.id);
    const groups = (await betaGroups(app.id)).map((g) => g.attributes.name);
    console.log(JSON.stringify({ appId: app.id, name: app.attributes.name, latestBuild: latest ? latest.attributes : null, groups }, null, 2));
  },

  selftest() {
    const assert = (cond, msg) => { if (!cond) fail(`selftest: ${msg}`); };
    const parsed = parseArgs(["next-build", "--bundle-id", "cloud.x.y", "--fallback", "7", "--verbose"]);
    assert(parsed.command === "next-build" && parsed.flags["bundle-id"] === "cloud.x.y" && parsed.flags.fallback === "7" && parsed.flags.verbose === true, "parseArgs");
    assert(nextBuildNumber(null, "7") === 7, "no builds -> fallback");
    assert(nextBuildNumber(null, undefined) === 1, "no builds, no fallback -> 1");
    assert(nextBuildNumber("10", "3") === 11, "latest 10 fallback 3 -> 11");
    assert(nextBuildNumber("4", "9") === 10, "latest 4 fallback 9 -> 10");
    assert(nextBuildNumber("abc", "5") === 5, "unparseable latest -> fallback");
    const { generateKeyPairSync } = cryptoModule;
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" });
    const token = buildJwt({ keyId: "KEY123", issuerId: "issuer-uuid", pem, now: 1_700_000_000 });
    const [h, p, s] = token.split(".");
    const header = JSON.parse(Buffer.from(h, "base64url"));
    const payload = JSON.parse(Buffer.from(p, "base64url"));
    assert(header.alg === "ES256" && header.kid === "KEY123" && header.typ === "JWT", "jwt header");
    assert(payload.iss === "issuer-uuid" && payload.aud === "appstoreconnect-v1" && payload.exp - payload.iat === 900, "jwt payload");
    assert(Buffer.from(s, "base64url").length === 64, "ES256 signature is raw r||s (64 bytes)");
    console.log("[asc] selftest ok");
  },
};

import * as cryptoModule from "node:crypto";

function need(values) {
  for (const [k, v] of Object.entries(values)) if (v === undefined || v === true || v === "") fail(`missing --${k.replace(/([A-Z])/g, "-$1").toLowerCase()}`);
}

function fail(msg) { console.error(`[asc] ERROR: ${msg}`); process.exit(1); }

const { command, flags } = parseArgs(process.argv.slice(2));
if (!command || !commands[command]) {
  console.error(`usage: asc.mjs <${Object.keys(commands).join("|")}> [--flags]`);
  process.exit(1);
}
await commands[command](flags);
