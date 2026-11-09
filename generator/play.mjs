#!/usr/bin/env node
// Google Play Developer API v3 client for the shell pipeline. No dependencies, Node 22+.
//
//   node generator/play.mjs upload --package cloud.x.y --aab path/app-release.aab \
//        [--track internal] [--release-name "1.0 (12)"] [--status completed]
//   node generator/play.mjs latest-version-code --package cloud.x.y [--track internal]
//   node generator/play.mjs selftest
//
// Env: PLAY_SERVICE_ACCOUNT_JSON_B64, base64 of the service account key file (JSON with
// client_email and private_key). The service account must be invited in Play Console under
// Users and permissions with at least "Release to testing tracks" on the app.
//
// Exit codes: 0 ok, 1 error (API or usage), 3 a manual step is required (the app does not exist
// in Play Console or its first AAB was never uploaded by hand; the API cannot do either).
//
// latest-version-code prints only a number so the CI can capture it: the highest versionCode
// across the releases of the track, or 0 when the track is empty.

import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";

const API = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const UPLOAD_API = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
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

export function buildAssertion({ clientEmail, pem, now = Math.floor(Date.now() / 1000) }) {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iss: clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 };
  const unsigned = `${b64url(header)}.${b64url(payload)}`;
  const signature = sign("RSA-SHA256", Buffer.from(unsigned), createPrivateKey(pem));
  return `${unsigned}.${signature.toString("base64url")}`;
}

function serviceAccount() {
  const raw = process.env.PLAY_SERVICE_ACCOUNT_JSON_B64;
  if (!raw) fail("Set PLAY_SERVICE_ACCOUNT_JSON_B64 (base64 of the service account key JSON).");
  const sa = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  if (!sa.client_email || !sa.private_key) fail("service account JSON lacks client_email or private_key");
  return sa;
}

let cachedToken = null;
async function accessToken() {
  if (cachedToken) return cachedToken;
  const sa = serviceAccount();
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: buildAssertion({ clientEmail: sa.client_email, pem: sa.private_key }),
  });
  const res = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`token endpoint -> ${res.status}: ${text.slice(0, 600)}`);
  cachedToken = JSON.parse(text).access_token;
  return cachedToken;
}

// ---------- HTTP ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, url, body, contentType = "application/json") {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${await accessToken()}`, "content-type": contentType, accept: "application/json" },
      body: body === undefined ? undefined : (contentType === "application/json" ? JSON.stringify(body) : body),
    });
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : null;
    if (manualStepError(res.status, text)) {
      console.error(`[play] ${method} ${url} -> ${res.status}: ${text.slice(0, 300)}`);
      console.error("[play] The app must exist in Play Console with its first AAB uploaded by hand (the API never does the first upload),");
      console.error("[play] and the service account must be invited under Users and permissions with 'Release to testing tracks' on the app.");
      process.exit(EXIT_MANUAL_STEP);
    }
    if (attempt === 1 && (res.status === 429 || res.status >= 500)) { await sleep(5000); continue; }
    throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 600)}`);
  }
}

export function manualStepError(status, text) {
  if (status === 404 && /package\s*(name)?\s*not\s*found|not\s*found/i.test(text)) return true;
  if (status === 403 && /(not\s*(been\s*)?(found|granted)|does\s*not\s*have|no\s*access|permission)/i.test(text)) return true;
  return false;
}

// ---------- Edits ----------
const editsUrl = (pkg) => `${API}/applications/${encodeURIComponent(pkg)}/edits`;

async function insertEdit(pkg) { return (await api("POST", editsUrl(pkg), {})).id; }

export function maxVersionCode(track) {
  let max = 0;
  for (const release of track?.releases || []) {
    for (const code of release.versionCodes || []) max = Math.max(max, Number.parseInt(code, 10) || 0);
  }
  return max;
}

// ---------- Commands ----------
const commands = {
  async upload({ package: pkg, aab, track = "internal", "release-name": releaseName, status = "completed" }) {
    need({ package: pkg, aab });
    const bytes = readFileSync(aab);
    const editId = await insertEdit(pkg);
    console.error(`[play] edit ${editId}; uploading ${aab} (${bytes.length} bytes)`);
    const bundle = await api("POST", `${UPLOAD_API}/applications/${encodeURIComponent(pkg)}/edits/${editId}/bundles?uploadType=media`, bytes, "application/octet-stream");
    const versionCode = bundle.versionCode;
    if (versionCode === undefined) fail(`bundle upload returned no versionCode: ${JSON.stringify(bundle).slice(0, 300)}`);
    const release = { status, versionCodes: [String(versionCode)] };
    if (releaseName) release.name = releaseName;
    await api("PUT", `${editsUrl(pkg)}/${editId}/tracks/${encodeURIComponent(track)}`, { track, releases: [release] });
    await api("POST", `${editsUrl(pkg)}/${editId}:commit`);
    console.log(JSON.stringify({ versionCode, track, status }));
  },

  async "latest-version-code"({ package: pkg, track = "internal" }) {
    need({ package: pkg });
    const editId = await insertEdit(pkg);
    try {
      const t = await api("GET", `${editsUrl(pkg)}/${editId}/tracks/${encodeURIComponent(track)}`);
      console.log(maxVersionCode(t));
    } finally {
      await api("DELETE", `${editsUrl(pkg)}/${editId}`).catch(() => {});
    }
  },

  selftest() {
    const assert = (cond, msg) => { if (!cond) fail(`selftest: ${msg}`); };
    const parsed = parseArgs(["upload", "--package", "cloud.x.y", "--aab", "a.aab", "--track", "internal"]);
    assert(parsed.command === "upload" && parsed.flags.package === "cloud.x.y" && parsed.flags.aab === "a.aab" && parsed.flags.track === "internal", "parseArgs");
    assert(maxVersionCode({ releases: [{ versionCodes: ["3", "12"] }, { versionCodes: ["7"] }] }) === 12, "maxVersionCode");
    assert(maxVersionCode({ releases: [] }) === 0 && maxVersionCode(undefined) === 0, "empty track -> 0");
    assert(manualStepError(404, '{"error":{"message":"Package not found: cloud.x.y."}}'), "404 package not found");
    assert(manualStepError(403, '{"error":{"message":"The caller does not have permission"}}'), "403 permission");
    assert(!manualStepError(400, '{"error":{"message":"APK specifies a version code that has already been used."}}'), "400 is a real error");
    const { generateKeyPairSync } = cryptoModule;
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" });
    const token = buildAssertion({ clientEmail: "sa@project.iam.gserviceaccount.com", pem, now: 1_700_000_000 });
    const [h, p, s] = token.split(".");
    const header = JSON.parse(Buffer.from(h, "base64url"));
    const payload = JSON.parse(Buffer.from(p, "base64url"));
    assert(header.alg === "RS256" && header.typ === "JWT", "jwt header");
    assert(payload.iss === "sa@project.iam.gserviceaccount.com" && payload.scope === SCOPE && payload.aud === TOKEN_URL && payload.exp - payload.iat === 3600, "jwt payload");
    assert(Buffer.from(s, "base64url").length === 256, "RS256 signature is 256 bytes for a 2048-bit key");
    console.log("[play] selftest ok");
  },
};

import * as cryptoModule from "node:crypto";

function need(values) {
  for (const [k, v] of Object.entries(values)) if (v === undefined || v === true || v === "") fail(`missing --${k}`);
}

function fail(msg) { console.error(`[play] ERROR: ${msg}`); process.exit(1); }

const { command, flags } = parseArgs(process.argv.slice(2));
if (!command || !commands[command]) {
  console.error(`usage: play.mjs <${Object.keys(commands).join("|")}> [--flags]`);
  process.exit(1);
}
await commands[command](flags);
