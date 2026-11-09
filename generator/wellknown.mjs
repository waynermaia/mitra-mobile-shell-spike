#!/usr/bin/env node
// POC: the app association files a published host must serve for the shell to claim its links
// and its sign-in callback, and the KeyValueStore entry the platform edge reads to serve them.
//
//   node generator/wellknown.mjs --project out/<slug> --team P6W44YNWTY \
//        [--keystore .secrets/upload.jks --storepass ... [--alias upload]] \
//        [--play-sha256 "CF:CD:..."] [--kvs-arn arn:aws:cloudfront::<account>:key-value-store/<id>]
//
// Reads mitra-shell.json from the generated project (app id, host). Writes under
// <project>/wellknown/: apple-app-site-association, assetlinks.json and kvs-value.json, and
// prints the aws cloudfront-keyvaluestore put-key command when --kvs-arn is given (the command
// is printed, never run: writing the edge store of an environment is an operator step).
//
// The Android fingerprints are the certificates that sign what reaches the device: the upload
// key when the APK is installed by adb, the Play App Signing key (Play Console > App signing >
// Digital Asset Links JSON) when it comes from the store. Both can be listed; Android accepts any.
//
// Exit codes: 0 ok, 1 error.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith("--")) continue;
  const next = args[i + 1];
  if (next === undefined || next.startsWith("--")) flags[a.slice(2)] = true;
  else { flags[a.slice(2)] = next; i++; }
}

if (flags.selftest) { selftest(); process.exit(0); }

const projectDir = resolve(flags.project || fail("Missing --project out/<slug>"));
const descriptorPath = join(projectDir, "mitra-shell.json");
if (!existsSync(descriptorPath)) fail(`${descriptorPath} not found; generate the project first`);
const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
const teamId = String(flags.team || process.env.APPLE_TEAM_ID || fail("Missing --team <Apple Team ID> (or APPLE_TEAM_ID)"));
const appId = descriptor.appId;
const host = new URL(descriptor.url).host.toLowerCase();

const fingerprints = [];
if (flags.keystore) fingerprints.push(keystoreSha256(flags.keystore, flags.storepass, flags.alias || "upload"));
for (const fp of String(flags["play-sha256"] || "").split(",").map((s) => s.trim()).filter(Boolean)) fingerprints.push(normalizeFingerprint(fp));
if (fingerprints.length === 0) fail("Give --keystore (upload key) and/or --play-sha256 (Play App Signing key); Android needs at least one certificate fingerprint");

const entry = kvsEntry({ teamId, appId, fingerprints });
const outDir = join(projectDir, "wellknown");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "apple-app-site-association"), JSON.stringify(aasa(entry.ios), null, 2) + "\n");
writeFileSync(join(outDir, "assetlinks.json"), JSON.stringify(assetlinks(entry.android), null, 2) + "\n");
writeFileSync(join(outDir, "kvs-value.json"), JSON.stringify(entry) + "\n");

const value = JSON.stringify(entry);
log(`host     ${host}`);
log(`ios      ${entry.ios.join(", ")}`);
log(`android  ${appId} with ${fingerprints.length} fingerprint(s)`);
log(`value    ${Buffer.byteLength(value)} bytes (KVS limit 1024)`);
log(`files    ${outDir}/`);
if (Buffer.byteLength(value) > 1024) fail("KVS value exceeds 1 KB; fewer fingerprints");
if (flags["kvs-arn"]) {
  console.log("\nOperator step (writes the edge store of the environment, run it only with approval):\n");
  console.log(`aws cloudfront-keyvaluestore put-key --kvs-arn '${flags["kvs-arn"]}' \\`);
  console.log(`  --key 'mobile:${host}' --value '${value}' \\`);
  console.log(`  --if-match "$(aws cloudfront-keyvaluestore describe-key-value-store --kvs-arn '${flags["kvs-arn"]}' --query ETag --output text)"`);
  console.log(`\ncurl -s https://${host}/.well-known/apple-app-site-association   # expect the AASA JSON, not the index.html`);
}

// ---------- pure parts ----------
export function kvsEntry({ teamId, appId, fingerprints }) {
  return { ios: [`${teamId}.${appId}`], android: [{ package: appId, sha256: fingerprints }] };
}
export function aasa(ios) {
  return { applinks: { details: [{ appIDs: ios, components: [{ "/": "*" }] }] }, webcredentials: { apps: ios } };
}
export function assetlinks(android) {
  return android.map((app) => ({
    relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app", package_name: app.package, sha256_cert_fingerprints: app.sha256 }
  }));
}
export function normalizeFingerprint(fp) {
  const hex = fp.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (hex.length !== 64) fail(`Not a SHA-256 fingerprint: ${fp}`);
  return hex.match(/.{2}/g).join(":");
}

// ---------- helpers ----------
function keystoreSha256(keystore, storepass, alias) {
  if (!storepass) fail("--keystore needs --storepass");
  const out = execFileSync("keytool", ["-list", "-v", "-keystore", resolve(keystore), "-storepass", storepass, "-alias", alias], { encoding: "utf8" });
  const m = out.match(/SHA256:\s*([0-9A-F:]{95})/);
  if (!m) fail(`keytool did not print a SHA256 fingerprint for alias ${alias}`);
  return m[1];
}
function selftest() {
  const e = kvsEntry({ teamId: "T1", appId: "cloud.infusion.x", fingerprints: ["AA:BB"] });
  if (e.ios[0] !== "T1.cloud.infusion.x" || e.android[0].package !== "cloud.infusion.x") throw new Error("kvsEntry");
  if (aasa(e.ios).webcredentials.apps[0] !== "T1.cloud.infusion.x") throw new Error("aasa");
  if (assetlinks(e.android)[0].target.sha256_cert_fingerprints[0] !== "AA:BB") throw new Error("assetlinks");
  if (normalizeFingerprint("a4 5e 81 d8 38 6c dc 9f 20 f6 8d 45 70 25 1a f4 48 97 a3 f6 f9 b5 68 a0 ae 74 65 a6 80 06 2f e0") !== "A4:5E:81:D8:38:6C:DC:9F:20:F6:8D:45:70:25:1A:F4:48:97:A3:F6:F9:B5:68:A0:AE:74:65:A6:80:06:2F:E0") throw new Error("normalize");
  console.log("[wellknown] selftest ok");
}
function log(msg) { console.log(`[wellknown] ${msg}`); }
function fail(msg) { console.error(`[wellknown] ERROR: ${msg}`); process.exit(1); }
