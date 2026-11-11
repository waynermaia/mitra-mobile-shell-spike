#!/usr/bin/env node
// Generate a Capacitor shell for ONE app published by the platform.
//
//   node generator/generate.mjs --app <app uuid> [--api https://beta.mitralab.io] [...flags]
//   node generator/generate.mjs --url https://<published host> [...flags]
//   node generator/generate.mjs --descriptor path/to/app.json [flags override the file]
//   node generator/generate.mjs --selftest
//
//   flags: [--name "..."] [--app-id x.y.z] [--icon <file|url>] [--theme "#0f172a"] [--version 1.0]
//          [--build-number 1] [--associated-domains] [--auth-hosts a.com,b.com] [--out out]
//          [--callback scheme|https] [--build debug|release] [--install] [--no-ios] [--debug]
//          [--verbose] [--identity] [--push] [--google-services <google-services.json>]
//
// Source of truth for the identity is the platform: GET {api}/code-studio/api/v1/apps/{app}/info
// (public, no token) gives name, published origins, accent color and the login logo. The page
// itself is only scraped for what the API does not carry yet (the icon when there is no login
// logo, title and theme-color in --url mode). An app without an icon gets one drawn from its
// initials on the theme color. Then it writes package.json +
// capacitor.config.json + www/ + assets/, npm ci,
// cap add android/ios, apply the native patches (App Link intent-filter, onNewIntent
// in MainActivity, release signing from env, exempt encryption, optional Associated Domains,
// SceneDelegate with the sign-in session and Universal Link handling on iOS),
// generate icons and splash, cap sync, copy the CI workflow. Optionally builds and installs
// the Android APK on the connected device or emulator.
//
// Sign-in return (--callback): the SDK ends a redirect sign-in on the app host, in the system
// browser, with the single-use code in the URL fragment. "scheme" (default) brings it back to the
// shell by a URL scheme named after the app id, which needs nothing on the host: the app page
// bounces the fragment to the scheme (the snippet in app-snippet/, which the app must include).
// "https" is the Universal Link callback, which needs the host to serve the
// apple-app-site-association file and --associated-domains.
//
// Push (--push): off by default, and then the push plugin is left out of the native projects, so a
// page that calls it gets "not implemented". iOS needs only the flag (aps-environment entitlement
// and the AppDelegate hooks). Android also needs the Firebase config of this application id
// (--google-services or GOOGLE_SERVICES_JSON_B64); without it Android is built without the plugin,
// because the plugin crashes the app on register() when Firebase is not configured.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const templateRoot = resolve(here, "..");

// ---------- CLI ----------
const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith("--")) continue;
  const key = a.slice(2);
  const next = args[i + 1];
  if (next === undefined || next.startsWith("--")) flags[key] = true;
  else { flags[key] = next; i++; }
}

const HEX_COLOR = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;
const DEFAULT_THEME_COLOR = "#0f172a";

if (flags.selftest) { selftest(); process.exit(0); }

const descriptor = flags.descriptor ? JSON.parse(readFileSync(resolve(flags.descriptor), "utf8")) : {};
const appUuid = flags.app || descriptor.app;
const apiBase = String(flags.api || descriptor.api || process.env.MITRA_API_URL || "https://beta.mitralab.io").replace(/\/$/, "");
const outRoot = resolve(flags.out || descriptor.out || join(templateRoot, "out"));
const wantIos = !flags["no-ios"] && descriptor.ios !== false;

// ---------- 1. Resolve the app identity ----------
// Platform first: the public app info carries name, origins, accent color and login logo.
const info = appUuid ? await fetchAppInfo(apiBase, appUuid) : null;
const url = flags.url || descriptor.url || (info && pickOrigin(info.origins));
if (!url) fail("Missing --app <uuid> (platform app) or --url <published URL>, or a descriptor with one of them.");
if (info && !info.origins?.length) fail(`App ${appUuid} has no published origin yet; publish it first or pass --url.`);
const page = await fetchText(url);
const scraped = scrape(page, url);
const appName = clean(flags.name || descriptor.name || info?.name || scraped.title || new URL(url).hostname);
const slug = slugify(appName);
const appId = flags["app-id"] || descriptor.appId || `cloud.${brandSegment(info?.brand)}.${packageSegment(slug)}`;
let themeColor;
try {
  themeColor = resolveThemeColor(flags.theme || descriptor.themeColor, [info?.accentColor, scraped.themeColor]);
} catch (e) { fail(e.message); }
// Both end up unquoted or inside a Groovy string in build.gradle and in the Xcode project.
const versionName = String(flags.version || descriptor.version || "1.0");
if (!isVersionName(versionName)) fail(`--version must look like 1, 1.2 or 1.2.3, got ${JSON.stringify(versionName)}`);
const buildNumber = Number(flags["build-number"] || descriptor.buildNumber || 1);
if (!Number.isInteger(buildNumber) || buildNumber < 1) fail("--build-number must be a positive integer");
const associatedDomains = Boolean(flags["associated-domains"] || descriptor.associatedDomains);
const callback = String(flags.callback || descriptor.callback || "scheme");
if (!["scheme", "https"].includes(callback)) fail(`--callback must be scheme or https, got ${callback}`);
const wantPush = Boolean(flags.push || descriptor.push);
const iconSource = flags.icon || descriptor.icon || info?.logoUrl || scraped.icon;
const host = new URL(url).host;
// The host is written into AndroidManifest.xml and the iOS entitlements as is.
if (!isPlainHost(host)) fail(`Unsupported host in the app URL: ${JSON.stringify(host)}`);
// A bundle id is a valid URL scheme (letters, digits, dot, hyphen), unique per app on the device.
const callbackScheme = callback === "scheme" ? appId.toLowerCase() : undefined;
// Hosts whose top-level navigation is a sign-in: the shell opens them in a native auth session
// (iOS) so the return lands in the WebView. The platform API host is where the SDK redirect
// starts; the providers are where it continues.
const DEFAULT_AUTH_HOSTS = ["accounts.google.com", "login.microsoftonline.com", "login.live.com", "appleid.apple.com"];
// The auth page the SDK starts on is named by the published page itself (window.__mitraEnv.authPageUrl)
// and is not always on the API host: the Infusion brand serves it from app.infusion.cloud.
const authPageHost = (page.match(/"authPageUrl"\s*:\s*"(https?:\/\/[^"\/]+)/) || [])[1];
const authHosts = [...new Set([
  new URL(apiBase).host,
  ...(authPageHost ? [new URL(authPageHost).host] : []),
  ...(descriptor.authHosts || []),
  ...String(flags["auth-hosts"] || "").split(",").map((s) => s.trim()).filter(Boolean),
  ...DEFAULT_AUTH_HOSTS
].map((h) => h.toLowerCase()))];
const projectDir = join(outRoot, slug);

validateAppId(appId);
const googleServices = wantPush ? readGoogleServices(appId) : null;
const pushIos = wantPush && wantIos;
const pushAndroid = Boolean(googleServices);
if (info) log(`source   ${apiBase}/code-studio/api/v1/apps/${appUuid}/info (origins: ${info.origins.join(", ")})`);
log(`app      ${appName}`);
log(`slug     ${slug}`);
log(`appId    ${appId}`);
log(`url      ${url}`);
log(`theme    ${themeColor}`);
log(`icon     ${iconSource ? describe(iconSource) : `(none, drawing the initials ${initials(appName, slug)})`}`);
log(`push     ${wantPush ? `ios ${pushIos ? "on" : "off"}, android ${pushAndroid ? "on" : "off (no Firebase config for " + appId + ")"}` : "off"}`);
log(`out      ${projectDir}`);

// --identity: resolve and print the identity only (CI uses it to ask App Store Connect for the
// next build number before generating, since the bundle id derives from the app name).
if (flags.identity) {
  const identity = { slug, appName, appId, url, host, authHosts, callback, callbackScheme, push: wantPush };
  console.log(JSON.stringify(identity));
  githubOutputs(identity);
  process.exit(0);
}

// ---------- 2. Scaffold the web side ----------
if (existsSync(projectDir)) {
  log("out dir exists, removing it for a clean generation");
  rmSync(projectDir, { recursive: true, force: true });
}
mkdirSync(join(projectDir, "www"), { recursive: true });
mkdirSync(join(projectDir, "assets"), { recursive: true });

const templatePkg = JSON.parse(readFileSync(join(templateRoot, "package.json"), "utf8"));
const pkg = {
  name: `mitra-shell-${slug}`,
  version: `${versionName}.${buildNumber}`,
  private: true,
  type: "commonjs",
  description: `Capacitor shell for ${appName} (${url}), generated by mitra-mobile-shell/generator`,
  scripts: {
    sync: "cap sync",
    assets: `capacitor-assets generate --iconBackgroundColor '${themeColor}' --iconBackgroundColorDark '${themeColor}' --splashBackgroundColor '${themeColor}' --splashBackgroundColorDark '${themeColor}'`
  },
  dependencies: templatePkg.dependencies
};
writeJson(join(projectDir, "package.json"), pkg);
cpSync(join(templateRoot, "package-lock.json"), join(projectDir, "package-lock.json"));
cpSync(join(here, "templates", "gitignore"), join(projectDir, ".gitignore"));

// The published page is not ours, so a plugin is in a platform only when that platform is ready
// for it: the push plugin crashes Android on register() without Firebase, and on iOS it would
// ship code for an entitlement the app does not have.
const PUSH_PLUGIN = "@capacitor/push-notifications";
const capPlugins = Object.keys(templatePkg.dependencies)
  .filter((d) => d.startsWith("@capacitor/") && !["android", "ios", "core", "cli", "assets"].includes(d.split("/")[1]));
const pluginsFor = (push) => capPlugins.filter((d) => push || d !== PUSH_PLUGIN);

writeJson(join(projectDir, "capacitor.config.json"), {
  appId,
  appName,
  webDir: "www",
  server: { url, cleartext: false },
  ios: { contentInset: "automatic", includePlugins: pluginsFor(pushIos) },
  android: { allowMixedContent: false, webContentsDebuggingEnabled: Boolean(flags.debug || descriptor.debug), includePlugins: pluginsFor(pushAndroid) },
  plugins: {
    SplashScreen: { launchShowDuration: 1500, launchAutoHide: true, backgroundColor: themeColor, showSpinner: false },
    StatusBar: { style: isDark(themeColor) ? "DARK" : "LIGHT", backgroundColor: themeColor },
    MitraShell: { authHosts, ...(callbackScheme ? { callbackScheme } : {}) },
    ...(wantPush ? { PushNotifications: { presentationOptions: ["badge", "sound", "alert"] } } : {})
  }
});

writeFileSync(join(projectDir, "www", "index.html"), offlinePage(appName, themeColor));

// Icon: @capacitor/assets takes assets/logo.(svg|png) and derives icon and splash from it.
const logoPath = await materializeIcon(iconSource, join(projectDir, "assets"), initialsLogoSvg(initials(appName, slug), themeColor));
log(`logo     ${logoPath}`);

// Descriptor echo, so the generated project is reproducible from itself.
writeJson(join(projectDir, "mitra-shell.json"), {
  app: appUuid, api: appUuid ? apiBase : undefined,
  url, name: appName, appId, themeColor, version: versionName, buildNumber, associatedDomains, authHosts, callback,
  push: wantPush ? { ios: pushIos, android: pushAndroid } : false,
  icon: iconSource && !String(iconSource).startsWith("data:") ? iconSource : undefined,
  generatedAt: new Date().toISOString()
});

// ---------- 3. Native projects ----------
run("npm", ["ci", "--no-audit", "--no-fund", "--loglevel=error"], projectDir);
run("npx", ["cap", "add", "android"], projectDir);
if (wantIos) run("npx", ["cap", "add", "ios"], projectDir);

// ---------- 4. Android patches ----------
patchAndroid(projectDir, { appId, host, versionName, buildNumber, callbackScheme, googleServices });

// ---------- 5. iOS patches ----------
if (wantIos) patchIos(projectDir, { appId, host, versionName, buildNumber, associatedDomains, callbackScheme, push: pushIos });
if (wantIos) log(`ios      SceneDelegate with sign-in session for ${authHosts.join(", ")}, callback ${callbackScheme ? callbackScheme + "://" : "https://" + host + "/"}`);

// ---------- 6. Assets, sync, CI ----------
run("npm", ["run", "assets"], projectDir);
run("npx", ["cap", "sync"], projectDir);
mkdirSync(join(projectDir, ".github", "workflows"), { recursive: true });
cpSync(join(here, "templates", "github", "mobile.yml"), join(projectDir, ".github", "workflows", "mobile.yml"));
writeFileSync(join(projectDir, "README.md"), readme({ appName, appId, url, slug, associatedDomains, callbackScheme, pushIos, pushAndroid }));
if (wantPush) {
  mkdirSync(join(projectDir, "app-snippet"), { recursive: true });
  writeFileSync(join(projectDir, "app-snippet", "push-example.html"), pushExampleSnippet());
  log("snippet  app-snippet/push-example.html (how the app page asks for the push token)");
}

// What the published app itself has to carry for the return by scheme: the snippet for the head
// of its index.html (the host serves nothing for the shell). The assetlinks.json Android reads
// comes from generator/wellknown.mjs and goes to public/.well-known/ of the app.
if (callbackScheme) {
  mkdirSync(join(projectDir, "app-snippet"), { recursive: true });
  writeFileSync(join(projectDir, "app-snippet", "shell-return.html"), shellReturnSnippet(callbackScheme));
  log(`snippet  app-snippet/shell-return.html (the app includes it in index.html; return scheme ${callbackScheme}://)`);
}

// ---------- 7. Optional: build and install ----------
const build = flags.build || descriptor.build;
let apk;
if (build) {
  const task = build === "release" ? "assembleRelease" : "assembleDebug";
  run("./gradlew", ["--no-daemon", "-q", task], join(projectDir, "android"));
  apk = findApk(join(projectDir, "android", "app", "build", "outputs", "apk", build === "release" ? "release" : "debug"));
  log(`apk      ${apk}`);
  if (flags.install || descriptor.install) {
    run("adb", ["install", "-r", apk], projectDir);
    log(`installed ${appId} on the connected device`);
  }
}

// Machine-readable summary for the caller (CI reads it to name artifacts and find the project).
const summary = { slug, appName, appId, url, host, projectDir, apk, pushIos, pushAndroid };
writeJson(join(outRoot, "last.json"), summary);
githubOutputs(summary);
log("done");

// ======================================================================
function scrape(html, baseUrl) {
  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1];
  const themeColor = (html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i) || [])[1];
  // Prefer the apple-touch-icon (square, no transparency expected), then any rel=icon.
  const links = [...html.matchAll(/<link\s+[^>]*>/gi)].map((m) => m[0]);
  const pick = (test) => {
    for (const tag of links) {
      const rel = (tag.match(/rel=["']([^"']+)["']/i) || [])[1] || "";
      if (!test(rel.toLowerCase())) continue;
      const href = (tag.match(/href=["']([^"']+)["']/i) || [])[1];
      if (href) return href.startsWith("data:") ? href : new URL(href, baseUrl).toString();
    }
  };
  const icon = pick((r) => r.includes("apple-touch-icon")) || pick((r) => r.split(/\s+/).includes("icon"));
  return { title: title && decodeEntities(title.trim()), themeColor, icon };
}

async function materializeIcon(source, assetsDir, fallbackSvg) {
  if (!source) {
    writeFileSync(join(assetsDir, "logo.svg"), fallbackSvg);
    return join(assetsDir, "logo.svg");
  }
  let bytes;
  let ext;
  if (String(source).startsWith("data:")) {
    const m = String(source).match(/^data:([^;,]+)(;base64)?,(.*)$/s);
    if (!m) fail("Unreadable data: URI in the icon");
    ext = mimeToExt(m[1]);
    bytes = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8");
  } else if (/^https?:/.test(source)) {
    const res = await fetch(source);
    if (!res.ok) fail(`Icon download failed: ${res.status} ${source}`);
    ext = mimeToExt(res.headers.get("content-type") || "") || extname(new URL(source).pathname).slice(1) || "png";
    bytes = Buffer.from(await res.arrayBuffer());
  } else {
    // A path is only read when the caller gave it; the platform and the page are third parties.
    if (source !== (flags.icon || descriptor.icon)) fail(`Icon must be an http(s) or data: URL, got ${JSON.stringify(source)}`);
    const p = resolve(source);
    ext = extname(p).slice(1).toLowerCase();
    bytes = readFileSync(p);
  }
  if (!["svg", "png"].includes(ext)) fail(`Icon must be SVG or PNG, got ${ext}`);
  const target = join(assetsDir, `logo.${ext}`);
  writeFileSync(target, bytes);
  return target;
}

function patchAndroid(dir, { appId, host, versionName, buildNumber, callbackScheme, googleServices }) {
  const app = join(dir, "android", "app");

  // Manifest: App Link for the published host, so the sign-in that ends on this host comes
  // back to the shell instead of staying in Chrome.
  const manifestPath = join(app, "src", "main", "AndroidManifest.xml");
  let manifest = readFileSync(manifestPath, "utf8");
  const filter = `
            <!-- App Link for the published app host (needs /.well-known/assetlinks.json there) -->
            <intent-filter android:autoVerify="true">
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="https" android:host="${host}" />
            </intent-filter>${callbackScheme ? `
            <!-- Sign-in return by URL scheme: the app page bounces the SDK fragment here (see app-snippet/) -->
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="${callbackScheme}" />
            </intent-filter>` : ""}
        </activity>`;
  manifest = manifest.replace(/\s*<\/activity>/, filter);
  if (googleServices) {
    // Android 13+ shows a notification only with this permission, which the page asks for with
    // PushNotifications.requestPermissions().
    manifest = manifest.replace(/(\s*)<uses-permission android:name="android.permission.INTERNET" \/>/,
      `$&$1<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />`);
    if (!manifest.includes("POST_NOTIFICATIONS")) fail("AndroidManifest layout changed, the notification permission was not added");
    // The Capacitor template applies the google-services Gradle plugin when this file exists.
    writeFileSync(join(app, "google-services.json"), googleServices);
  }
  writeFileSync(manifestPath, manifest);

  // MainActivity: load the incoming link in the WebView.
  const javaDir = join(app, "src", "main", "java", ...appId.split("."));
  const mainActivity = join(javaDir, "MainActivity.java");
  if (!existsSync(mainActivity)) fail(`cap add did not create ${mainActivity}`);
  writeFileSync(mainActivity, mainActivityJava(appId, callbackScheme));

  // build.gradle: version and release signing from the environment.
  const gradlePath = join(app, "build.gradle");
  let gradle = readFileSync(gradlePath, "utf8");
  gradle = gradle.replace(/versionCode \d+/, `versionCode ${buildNumber}`).replace(/versionName "[^"]*"/, `versionName "${versionName}"`);
  if (!gradle.includes("ANDROID_KEYSTORE_PATH")) {
    gradle = gradle.replace(/\n    buildTypes \{\n        release \{\n/, `
    // Release signing comes from the environment (CI secrets or a local .env). Without it the
    // release build is unsigned, which is fine for a compile check.
    signingConfigs {
        release {
            def ksPath = System.getenv("ANDROID_KEYSTORE_PATH")
            if (ksPath != null && file(ksPath).exists()) {
                storeFile file(ksPath)
                storePassword System.getenv("KEYSTORE_PASSWORD")
                keyAlias System.getenv("KEY_ALIAS")
                keyPassword System.getenv("KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        release {
            if (System.getenv("ANDROID_KEYSTORE_PATH") != null) {
                signingConfig signingConfigs.release
            }
`);
    if (!gradle.includes("signingConfigs {")) fail("build.gradle layout changed, signing patch did not apply");
  }
  writeFileSync(gradlePath, gradle);

  // local.properties: point Gradle at the SDK on this machine (CI sets ANDROID_HOME itself).
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || firstExisting([
    "/opt/homebrew/share/android-commandlinetools",
    join(process.env.HOME || "", "Library", "Android", "sdk")
  ]);
  if (sdk) writeFileSync(join(dir, "android", "local.properties"), `sdk.dir=${sdk}\n`);
}

function patchIos(dir, { appId, host, versionName, buildNumber, associatedDomains, callbackScheme, push }) {
  const appDir = join(dir, "ios", "App", "App");
  const plistPath = join(appDir, "Info.plist");
  let plist = readFileSync(plistPath, "utf8");
  if (callbackScheme && !plist.includes("CFBundleURLTypes")) {
    // The sign-in return by scheme. ASWebAuthenticationSession catches it by itself; registering it
    // also brings a tap on the fallback link of the app page back to the shell.
    plist = plist.replace("\t<key>LSRequiresIPhoneOS</key>", `\t<key>CFBundleURLTypes</key>
\t<array>
\t\t<dict>
\t\t\t<key>CFBundleURLName</key>
\t\t\t<string>${appId}</string>
\t\t\t<key>CFBundleURLSchemes</key>
\t\t\t<array>
\t\t\t\t<string>${callbackScheme}</string>
\t\t\t</array>
\t\t</dict>
\t</array>
\t<key>LSRequiresIPhoneOS</key>`);
  }
  if (!plist.includes("ITSAppUsesNonExemptEncryption")) {
    plist = plist.replace("\t<key>LSRequiresIPhoneOS</key>", "\t<key>ITSAppUsesNonExemptEncryption</key>\n\t<false/>\n\t<key>LSRequiresIPhoneOS</key>");
  }
  writeFileSync(plistPath, plist);

  const pbxPath = join(dir, "ios", "App", "App.xcodeproj", "project.pbxproj");
  let pbx = readFileSync(pbxPath, "utf8");
  pbx = pbx.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${versionName};`)
           .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${buildNumber};`);
  if (!pbx.includes(`PRODUCT_BUNDLE_IDENTIFIER = ${appId};`)) fail("cap add ios did not set the bundle id");

  // The SceneDelegate the template ships: Universal Links loaded in the WebView and the sign-in
  // session for the identity hosts (see generator/templates/ios/SceneDelegate.swift).
  cpSync(join(here, "templates", "ios", "SceneDelegate.swift"), join(appDir, "SceneDelegate.swift"));

  // Universal Link and the https callback of the sign-in session, both on the published host:
  // only useful once the host serves /.well-known/apple-app-site-association, harmless before.
  // Push: Xcode switches aps-environment to production when it signs for the App Store.
  const entitlements = [
    ...(push ? ["\t<key>aps-environment</key>\n\t<string>development</string>"] : []),
    ...(associatedDomains ? [`\t<key>com.apple.developer.associated-domains</key>
\t<array>
\t\t<string>applinks:${host}</string>
\t\t<string>webcredentials:${host}</string>
\t</array>`] : [])
  ];
  if (entitlements.length) {
    writeFileSync(join(appDir, "App.entitlements"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${entitlements.join("\n")}
</dict>
</plist>
`);
    pbx = pbx.replace(new RegExp(`(\\t+)PRODUCT_BUNDLE_IDENTIFIER = ${appId.replace(/\./g, "\\.")};`, "g"),
      `$1CODE_SIGN_ENTITLEMENTS = App/App.entitlements;\n$1PRODUCT_BUNDLE_IDENTIFIER = ${appId};`);
  }
  if (push) {
    // The push plugin learns the device token (or the failure) from these two AppDelegate calls.
    const delegatePath = join(appDir, "AppDelegate.swift");
    let delegate = readFileSync(delegatePath, "utf8");
    if (!delegate.includes("capacitorDidRegisterForRemoteNotifications")) {
      const hooks = `
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }
}
`;
      const end = delegate.lastIndexOf("}");
      if (end === -1) fail("AppDelegate.swift layout changed, the push hooks were not added");
      delegate = delegate.slice(0, end).replace(/\s*$/, "\n") + hooks;
      writeFileSync(delegatePath, delegate);
    }
  }
  writeFileSync(pbxPath, pbx);
}

function mainActivityJava(appId, callbackScheme) {
  return `package ${appId};

import android.content.Intent;
import android.net.Uri;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private static final String SHELL_LINK_PARAM = "shellLink";
    // Sign-in return by URL scheme (null when the shell relies on the App Link alone).
    private static final String CALLBACK_SCHEME = ${callbackScheme ? JSON.stringify(callbackScheme) : "null"};

    // Capacitor only tells the web app about an incoming link (appUrlOpen); the app published
    // by the platform does not know the shell exists. So when the link is on the app's own host,
    // load it in the WebView: the SDK finishes the sign-in from the URL fragment at boot.
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent == null || getBridge() == null) return;
        Uri data = intent.getData();
        if (data == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return;

        String serverUrl = getBridge().getServerUrl();
        Uri app = Uri.parse(serverUrl != null ? serverUrl : getBridge().getAppUrl());
        if (CALLBACK_SCHEME != null && CALLBACK_SCHEME.equalsIgnoreCase(data.getScheme())) {
            // The app page bounced the SDK fragment to the shell by its scheme: carry the fragment
            // to the app host, where the SDK finishes the sign-in at boot.
            data = app.buildUpon().path("/").encodedQuery(data.getEncodedQuery())
                .encodedFragment(data.getEncodedFragment()).build();
        }
        if (data.getHost() == null || !data.getHost().equalsIgnoreCase(app.getHost())) return;

        // A fragment-only change would not reload the document, and the sign-in completes
        // only when the app boots. A fresh query value forces a full load.
        Uri target = data.buildUpon()
            .appendQueryParameter(SHELL_LINK_PARAM, String.valueOf(System.currentTimeMillis()))
            .build();
        WebView webView = getBridge().getWebView();
        webView.post(() -> webView.loadUrl(target.toString()));
    }
}
`;
}

// The return snippet of the published app. A sign-in the shell started ends in the system browser
// on the app host with the single-use code in the fragment; that browser never saw the sign-in
// context (it lives in the WebView, in sessionStorage), so the page hands the fragment to the shell
// by its scheme. A tab that holds a pending context started the sign-in itself and is left to the
// SDK, so the web app keeps working in a plain browser. The fragment is cleared before the SDK
// boots, or it would report the missing context as a CSRF error.
function shellReturnSnippet(scheme) {
  return `<script>
(function () {
  var scheme = ${JSON.stringify(scheme)};
  var hash = location.hash || "";
  if (hash.indexOf("codeMitra=") === -1 && hash.indexOf("errorMitra=") === -1) return;
  try {
    var stores = [sessionStorage, localStorage];
    for (var s = 0; s < stores.length; s++) {
      for (var i = 0; i < stores[s].length; i++) {
        if (/^mitra_[a-z]+_redirect_/.test(stores[s].key(i) || "")) return;
      }
    }
  } catch (e) {}
  var target = scheme + "://auth" + hash;
  history.replaceState(null, "", location.pathname + location.search);
  location.replace(target);
  document.addEventListener("DOMContentLoaded", function () {
    var a = document.createElement("a");
    a.href = target;
    a.textContent = "Voltar ao app";
    a.style.cssText = "position:fixed;left:0;right:0;bottom:32px;text-align:center;font:600 17px -apple-system,system-ui,sans-serif;z-index:2147483647";
    document.body.appendChild(a);
  });
})();
</script>
`;
}

// What the published app does to receive push. It is Capacitor's own plugin API, reached through
// the bridge the shell injects in the page, so the app needs no dependency.
function pushExampleSnippet() {
  return `<script>
// Call from a user action (a button), never at page load: iOS shows the permission dialog once.
async function enablePush(onToken, onNotification, onOpened) {
  var cap = window.Capacitor;
  var push = cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.PushNotifications;
  if (!push) return "unavailable";                        // plain browser, or a shell built without push
  push.addListener("registration", function (t) { onToken(t.value, cap.getPlatform()); });   // send to your backend with the signed-in user
  push.addListener("registrationError", function (e) { console.warn("push registration failed", e); });
  push.addListener("pushNotificationReceived", function (n) { if (onNotification) onNotification(n); });           // app in foreground
  push.addListener("pushNotificationActionPerformed", function (a) { if (onOpened) onOpened(a.notification); });   // user tapped it
  var perm = await push.requestPermissions();
  if (perm.receive !== "granted") return "denied";
  try { await push.register(); } catch (e) { return "unavailable"; }
  return "granted";
}
</script>
`;
}

function readGoogleServices(appId) {
  const raw = flags["google-services"] ? readFileSync(resolve(String(flags["google-services"])), "utf8")
    : descriptor.googleServices ? readFileSync(resolve(String(descriptor.googleServices)), "utf8")
    : process.env.GOOGLE_SERVICES_JSON_B64 ? Buffer.from(process.env.GOOGLE_SERVICES_JSON_B64, "base64").toString("utf8")
    : null;
  const fromEnv = !flags["google-services"] && !descriptor.googleServices;
  if (!raw) return null;
  let json;
  try { json = JSON.parse(raw); } catch { fail("The Firebase config (google-services.json) is not valid JSON"); }
  const packages = (json.client || []).map((c) => c.client_info?.android_client_info?.package_name);
  if (packages.includes(appId)) return raw;
  const hint = `The Firebase config has no Android app for ${appId} (it has: ${packages.join(", ") || "none"}). Register the app in the Firebase project and download the config again.`;
  // A file given for this app is a mistake (Gradle would fail later with "No matching client
  // found"). The shared config of the pipeline covers only the apps registered so far, so an app
  // missing from it is built without push on Android, as documented.
  if (!fromEnv) fail(hint);
  log(`push     android off: ${hint}`);
  return null;
}

function offlinePage(name, color) {
  const fg = isDark(color) ? "#e2e8f0" : "#0f172a";
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(name)}</title>
<style>
  body { margin: 0; font-family: -apple-system, system-ui, sans-serif; background: ${color}; color: ${fg};
         display: flex; min-height: 100vh; align-items: center; justify-content: center; text-align: center; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0; opacity: .8; }
</style>
</head>
<body>
  <div>
    <h1>Sem conexão</h1>
    <p>${escapeHtml(name)} precisa de internet. Conecte-se e abra de novo.</p>
  </div>
</body>
</html>
`;
}

function readme({ appName, appId, url, slug, associatedDomains, callbackScheme, pushIos, pushAndroid }) {
  return `# ${appName} (mobile shell)

Generated by \`mitra-mobile-shell/generator\` from ${url}. Do not edit by hand: change
\`mitra-shell.json\` (or the flags) and generate again.

- App id / bundle id: \`${appId}\`
- Loads: ${url}
- Android: App Link intent-filter for the host, \`onNewIntent\` hands sign-in returns to the WebView,
  release signing from \`ANDROID_KEYSTORE_PATH\`, \`KEYSTORE_PASSWORD\`, \`KEY_ALIAS\`, \`KEY_PASSWORD\`.
- iOS: exempt encryption declared; SceneDelegate opens sign-in hosts in an ASWebAuthenticationSession
  and loads Universal Links in the WebView; Associated Domains ${associatedDomains ? "ON (applinks and webcredentials for " + new URL(url).host + ")" : "off (pass --associated-domains once the host serves the AASA file)"}.
- Sign-in return: ${callbackScheme ? `by URL scheme \`${callbackScheme}://\` (nothing needed on the host). The app itself must carry
  \`app-snippet/shell-return.html\` in the head of its index.html, and for Android App Links its
  \`public/.well-known/assetlinks.json\` (from \`generator/wellknown.mjs\`).` : `by https callback on the app host (Universal Link),
  which needs the host to serve the apple-app-site-association file.`}
- Push: iOS ${pushIos ? "on (aps-environment entitlement, AppDelegate hooks)" : "off"}, Android ${pushAndroid ? "on (Firebase config in android/app/google-services.json, not to be committed)" : "off"}.${pushIos || pushAndroid ? " The page uses Capacitor's PushNotifications plugin through the bridge, see \`app-snippet/push-example.html\`." : ""}
- CI: \`.github/workflows/mobile.yml\` (secrets: Android keystore, App Store Connect API key).

\`\`\`bash
cd android && ./gradlew assembleDebug      # local APK
adb install -r app/build/outputs/apk/debug/app-debug.apk
\`\`\`

Slug: \`${slug}\`.
`;
}

// ---------- helpers ----------
async function fetchAppInfo(base, id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) fail(`--app must be the app UUID, got ${id}`);
  const u = `${base}/code-studio/api/v1/apps/${id}/info`;
  const res = await fetch(u, { headers: { accept: "application/json" } });
  if (!res.ok) fail(`GET ${u} returned ${res.status}`);
  return res.json();
}
function pickOrigin(origins) {
  // code-studio lists the platform host(s) first and the active custom domain last; the custom
  // domain is what the owner shows to users, so the last entry is the one the shell should load.
  return origins[origins.length - 1];
}
function brandSegment(brand) {
  return brand && /^[a-z][a-z0-9]*$/.test(brand) ? brand : "infusion";
}
function run(cmd, cmdArgs, cwd) {
  log(`$ ${cmd} ${cmdArgs.join(" ")}   (in ${cwd.replace(templateRoot, ".")})`);
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: flags.verbose ? "inherit" : ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
  if (r.status !== 0) {
    if (!flags.verbose) process.stderr.write((r.stdout || "") + (r.stderr || ""));
    fail(`${cmd} ${cmdArgs.join(" ")} exited with ${r.status}`);
  }
}
async function fetchText(u) {
  const res = await fetch(u, { redirect: "follow" });
  if (!res.ok) fail(`GET ${u} returned ${res.status}`);
  return res.text();
}
function clean(title) {
  // "Name - tagline", "Name | tagline" and the dash variants: keep the name only. Inner line
  // breaks of a page title collapse to a space: the name ends up in single-line files and outputs.
  return title.split(/\s+[-|\u2013\u2014:]\s+/)[0].replace(/\s+/g, " ").trim();
}
function slugify(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 40) || "app";
}
function packageSegment(seg) {
  const javaReserved = new Set(["abstract","assert","boolean","break","byte","case","catch","char","class","const","continue","default","do","double","else","enum","extends","final","finally","float","for","goto","if","implements","import","instanceof","int","interface","long","native","new","package","private","protected","public","return","short","static","strictfp","super","switch","synchronized","this","throw","throws","transient","try","void","volatile","while"]);
  if (/^\d/.test(seg)) seg = `app${seg}`;
  if (javaReserved.has(seg)) seg = `${seg}app`;
  return seg;
}
function isVersionName(v) { return /^\d+(\.\d+){0,2}$/.test(v); }
function isPlainHost(h) { return /^[a-z0-9.-]+(:\d+)?$/.test(h); }
function validateAppId(id) {
  const parts = id.split(".");
  if (parts.length < 2 || parts.some((p) => !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(p))) fail(`Invalid app id for Android/iOS: ${id}`);
}
// A color from the caller is a mistake to report; one from the platform or the page belongs to a
// third party and must not break the build, so it is skipped.
function resolveThemeColor(own, external) {
  if (own) {
    if (!HEX_COLOR.test(own)) throw new Error(`Theme color must be a hex color like #0f172a or #abc, got ${JSON.stringify(own)}`);
    return own;
  }
  for (const color of external.filter(Boolean)) {
    if (HEX_COLOR.test(color)) return color;
    log(`theme    ignoring ${JSON.stringify(color)} (not a hex color)`);
  }
  return DEFAULT_THEME_COLOR;
}
// Only A-Z and 0-9 come out of here, so the result goes into the SVG without escaping.
function initials(name, slug = "") {
  const words = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const letters = words.length >= 2 ? words[0][0] + words[1][0] : (words[0] || "").slice(0, 2);
  return letters || slug.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 2) || "A";
}
function initialsLogoSvg(letters, color) {
  // The baseline is computed from the cap height of Helvetica and Arial (0.716 em) because
  // librsvg, which rasterizes the file, ignores dominant-baseline. The size keeps the widest pair
  // ("WM") inside the circle Android guarantees to show of an adaptive icon (66% of the side).
  const size = 340;
  const baseline = Math.round(512 + 0.358 * size);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" fill="${color}"/>
  <text x="512" y="${baseline}" font-family="Helvetica, Arial, sans-serif" font-size="${size}" font-weight="700" fill="${isDark(color) ? "#ffffff" : "#0f172a"}" text-anchor="middle">${letters}</text>
</svg>
`;
}
function isDark(hex) {
  const m = hex.replace("#", "");
  const full = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) < 140;
}
function mimeToExt(mime) {
  if (/svg/.test(mime)) return "svg";
  if (/png/.test(mime)) return "png";
  return "";
}
function describe(src) { return String(src).startsWith("data:") ? "inline data: URI from the page" : String(src); }
function decodeEntities(s) { return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }
function escapeHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function writeJson(p, obj) { writeFileSync(p, JSON.stringify(obj, null, 2) + "\n"); }
function firstExisting(paths) { return paths.find((p) => p && existsSync(p)); }
function findApk(dir) {
  const apk = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith(".apk")) : undefined;
  if (!apk) fail(`No APK under ${dir}`);
  return join(dir, apk);
}
// GITHUB_OUTPUT is one "key=value" per line: a line break inside a value would let it define
// other outputs of the step.
function githubOutputLines(obj) {
  return Object.entries(obj).filter(([, v]) => v !== undefined && !Array.isArray(v)).map(([k, v]) => {
    if (/[\r\n]/.test(String(v))) throw new Error(`Output ${k} has a line break: ${JSON.stringify(v)}`);
    return `${k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase())}=${v}\n`;
  }).join("");
}
function githubOutputs(obj) {
  if (!process.env.GITHUB_OUTPUT) return;
  let lines;
  try { lines = githubOutputLines(obj); } catch (e) { fail(e.message); }
  writeFileSync(process.env.GITHUB_OUTPUT, lines, { flag: "a" });
}
function selftest() {
  const assert = (cond, msg) => { if (!cond) fail(`selftest: ${msg}`); };
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  for (const [name, expected] of [["Minha Casa", "MC"], ["ROUTER", "RO"], ["x", "X"], ["Ação Já", "AJ"],
    ["one two three", "OT"], ["  Café-da manhã ", "CD"], ["3M Company", "3C"], ["<b>&\"", "B"]]) {
    assert(initials(name) === expected, `initials(${JSON.stringify(name)}) is ${initials(name)}, expected ${expected}`);
  }
  assert(initials("!!!", "app") === "AP", "initials falls back to the slug");
  assert(initials("!!!") === "A", "initials falls back to A");
  const svg = initialsLogoSvg("MC", "#ffffff");
  assert(svg.includes(">MC</text>") && svg.includes('fill="#ffffff"') && svg.includes('fill="#0f172a"'), "light logo has dark letters");
  assert(initialsLogoSvg("MC", "#000").includes('fill="#ffffff"'), "dark logo has light letters");
  assert(resolveThemeColor("#ABC", ["#111111"]) === "#ABC", "own color wins");
  assert(throws(() => resolveThemeColor("red", [])), "own color must be hex");
  assert(throws(() => resolveThemeColor("#12345", [])), "5 hex digits are refused");
  assert(throws(() => resolveThemeColor("#fff' ; touch x '", [])), "shell text in the color is refused");
  assert(resolveThemeColor(undefined, [undefined, "rgb(1,2,3)", "#0a0b0c"]) === "#0a0b0c", "invalid external color is skipped");
  assert(resolveThemeColor(undefined, ["red", undefined]) === DEFAULT_THEME_COLOR, "no valid color -> default");
  assert(githubOutputLines({ appName: "A B", skip: undefined, list: ["x"], n: 3 }) === "app_name=A B\nn=3\n", "githubOutputLines");
  assert(throws(() => githubOutputLines({ appName: "A\nevil=1" })), "line feed in an output is refused");
  assert(throws(() => githubOutputLines({ appName: "A\rB" })), "carriage return in an output is refused");
  assert(clean("My\n  App | tagline") === "My App", "clean collapses line breaks");
  assert(isVersionName("1") && isVersionName("1.2.3") && !isVersionName("1.0${x}") && !isVersionName('1.0"') && !isVersionName("1.2.3.4"), "isVersionName");
  assert(isPlainHost("a-1.example.com") && isPlainHost("127.0.0.1:8099") && !isPlainHost('a"b.com') && !isPlainHost("a b"), "isPlainHost");
  console.log("[generate] selftest ok");
}
function log(msg) { console.log(`[generate] ${msg}`); }
function fail(msg) { console.error(`[generate] ERROR: ${msg}`); process.exit(1); }
