#!/usr/bin/env node
// The app association files a published host must serve for the shell to claim its links
// and its sign-in callback, written where the platform edge reads them.
//
//   node generator/wellknown.mjs --project out/<slug> --team <Apple Team ID> \
//        [--keystore .secrets/upload.jks [--storepass-env KEYSTORE_PASSWORD] [--alias upload]] \
//        [--play-sha256 "CF:CD:..."] [--bucket <deploys bucket> --prefix alpha/ [--key-host <host>]]
//
// Reads mitra-shell.json from the generated project (app id, host). Writes under
// <project>/wellknown/: apple-app-site-association and assetlinks.json, and prints the two
// aws s3 cp commands when --bucket is given (printed, never run: writing the deploys bucket of an
// environment is an operator step). The edge serves /.well-known/<file> of a host from the stable
// prefix of the host, {deploys_path_prefix}hosts/{host}/.well-known/<file>, the same place as the
// stable index.html. When the edge reads a host through the prefix of another host, --key-host
// names that one. Nothing is written to the KeyValueStore.
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
if (flags.storepass) fail("--storepass is not accepted: put the password in an environment variable and name it with --storepass-env");
if (flags.keystore) fingerprints.push(keystoreSha256(flags.keystore, String(flags["storepass-env"] || "KEYSTORE_PASSWORD"), flags.alias || "upload"));
for (const fp of String(flags["play-sha256"] || "").split(",").map((s) => s.trim()).filter(Boolean)) fingerprints.push(normalizeFingerprint(fp));
if (fingerprints.length === 0) fail("Give --keystore (upload key) and/or --play-sha256 (Play App Signing key); Android needs at least one certificate fingerprint");

const entry = appAssociation({ teamId, appId, fingerprints });
const outDir = join(projectDir, "wellknown");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "apple-app-site-association"), JSON.stringify(aasa(entry.ios), null, 2) + "\n");
writeFileSync(join(outDir, "assetlinks.json"), JSON.stringify(assetlinks(entry.android), null, 2) + "\n");

log(`host     ${host}`);
log(`ios      ${entry.ios.join(", ")}`);
log(`android  ${appId} with ${fingerprints.length} fingerprint(s)`);
log(`files    ${outDir}/`);
if (flags.bucket) {
  const keyHost = String(flags["key-host"] || host).toLowerCase();
  const prefix = String(flags.prefix || "");
  if (prefix && !prefix.endsWith("/")) fail("--prefix is the deploys_path_prefix of the environment and ends with a slash, like alpha/");
  const dest = `s3://${flags.bucket}/${prefix}hosts/${keyHost}/.well-known`;
  console.log("\nOperator step (writes the deploys bucket of the environment, run it only with approval):\n");
  for (const file of ["apple-app-site-association", "assetlinks.json"]) {
    console.log(`aws s3 cp '${join(outDir, file)}' '${dest}/${file}' --content-type application/json --cache-control no-cache`);
  }
  console.log(`\ncurl -s https://${host}/.well-known/apple-app-site-association   # expect the AASA JSON, not the index.html`);
  console.log(`curl -s https://${host}/.well-known/assetlinks.json`);
  if (keyHost === host) console.log("\n# 404 after the copy: the edge reads this host through the prefix of another host; repeat with --key-host <that host>.");
}

// ---------- pure parts ----------
export function appAssociation({ teamId, appId, fingerprints }) {
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
// keytool reads the password from the named variable, so it never shows in the process list.
function keystoreSha256(keystore, passwordEnv, alias) {
  if (!process.env[passwordEnv]) fail(`--keystore needs the keystore password in ${passwordEnv}`);
  const out = execFileSync("keytool", ["-list", "-v", "-keystore", resolve(keystore), "-storepass:env", passwordEnv, "-alias", alias], { encoding: "utf8" });
  const m = out.match(/SHA256:\s*([0-9A-F:]{95})/);
  if (!m) fail(`keytool did not print a SHA256 fingerprint for alias ${alias}`);
  return m[1];
}
function selftest() {
  const e = appAssociation({ teamId: "T1", appId: "cloud.infusion.x", fingerprints: ["AA:BB"] });
  if (e.ios[0] !== "T1.cloud.infusion.x" || e.android[0].package !== "cloud.infusion.x") throw new Error("appAssociation");
  if (aasa(e.ios).webcredentials.apps[0] !== "T1.cloud.infusion.x") throw new Error("aasa");
  if (assetlinks(e.android)[0].target.sha256_cert_fingerprints[0] !== "AA:BB") throw new Error("assetlinks");
  if (normalizeFingerprint("00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f 10 11 12 13 14 15 16 17 18 19 1a 1b 1c 1d 1e 1f") !== "00:01:02:03:04:05:06:07:08:09:0A:0B:0C:0D:0E:0F:10:11:12:13:14:15:16:17:18:19:1A:1B:1C:1D:1E:1F") throw new Error("normalize");
  console.log("[wellknown] selftest ok");
}
function log(msg) { console.log(`[wellknown] ${msg}`); }
function fail(msg) { console.error(`[wellknown] ERROR: ${msg}`); process.exit(1); }
