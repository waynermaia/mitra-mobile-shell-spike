# mitra-mobile-shell

Capacitor shell generator and store pipeline for Mitra platform apps (App Store and Google Play).

One repository serves every app. Nothing about a specific app is stored here: the generator
takes an app published by the platform and writes a complete Capacitor project for it (a native
shell whose WebView loads the published URL), and the workflows build that project and hand it
to the stores.

## Layout

- `generator/generate.mjs`: writes the Capacitor project for one app under `out/<slug>/`.
- `generator/asc.mjs`: App Store Connect API client (bundle id, build number, TestFlight group).
- `generator/play.mjs`: Google Play Developer API client (AAB upload to a track).
- `generator/wellknown.mjs`: writes the app association files (`apple-app-site-association`,
  `assetlinks.json`) for a generated project.
- `generator/templates/`: files copied into every generated project (iOS `SceneDelegate.swift`,
  its CI workflow, its `.gitignore`).
- `package.json` and `package-lock.json`: the pinned Capacitor dependencies. The generator copies
  both into the generated project, so a dependency bump here reaches every app.

## Running the generator

Needs Node 22. A debug or release build also needs Java 21 and the Android SDK; the iOS project
is generated on any machine but only builds on macOS with Xcode.

```bash
npm ci
node generator/generate.mjs --app <app uuid> [--api https://beta.mitralab.io] [flags]
node generator/generate.mjs --url https://<published host> [flags]
node generator/generate.mjs --descriptor path/to/app.json [flags override the file]
```

With `--app` the identity comes from the platform:
`GET {api}/code-studio/api/v1/apps/{app}/info` (public, no token) gives the name, the published
origins, the accent color and the login logo. With `--url` the name, theme color and icon are
read from the published page. The app id defaults to `cloud.<brand>.<slug>`. The API base URL
is `--api`, then the `MITRA_API_URL` environment variable, then `https://beta.mitralab.io`.

An app without an icon gets one drawn by the generator: the initials of its name (the first
letter of the first two words, or the first two letters of a single word) on the theme color.

| Flag | Effect |
|---|---|
| `--name "..."` | App name (default: platform name or page title) |
| `--app-id x.y.z` | Android application id and iOS bundle id |
| `--icon <file\|url>` | SVG or PNG icon (default: login logo, page icon, then the initials of the name) |
| `--theme "#0f172a"` | Splash and status bar color, as `#rgb` or `#rrggbb` |
| `--version 1.0`, `--build-number 1` | Marketing version and build number |
| `--out out` | Output root; the project goes to `<out>/<slug>/` |
| `--no-ios` | Android project only |
| `--callback scheme\|https` | How the sign-in returns to the shell, see below |
| `--associated-domains` | iOS `applinks` and `webcredentials` entitlements for the host |
| `--auth-hosts a.com,b.com` | Extra hosts opened in the native sign-in session on iOS |
| `--push`, `--google-services <file>` | Push notifications, see below |
| `--build debug\|release`, `--install` | Run Gradle, then `adb install` the APK |
| `--identity` | Resolve and print the identity only, generate nothing |
| `--debug`, `--verbose` | WebView debugging on Android; show the output of each command |

The run ends with `<out>/last.json` and, under GitHub Actions, the same fields as step outputs.
The generated project carries `mitra-shell.json`, the echo of what it was generated from.

### Sign-in return (`--callback`)

A redirect sign-in ends on the app host, in the system browser, with a single-use code in the
URL fragment. The shell has two ways to get it back into the WebView:

- `scheme` (default): the shell registers a URL scheme named after the app id. Nothing is served
  by the host; the published app includes `app-snippet/shell-return.html` (written into the
  generated project) in the head of its `index.html`, and that script hands the fragment to the
  scheme. Trade-off: another app installed on the device can register the same scheme and
  receive the single-use code.
- `https`: the return is a Universal Link (iOS) or App Link (Android) on the app host. It needs
  `--associated-domains` and the host serving `/.well-known/apple-app-site-association` and
  `/.well-known/assetlinks.json`, which `generator/wellknown.mjs` writes. No other app can claim
  the host, so this is the path for apps where the scheme risk is not acceptable.

### Push (`--push`)

Off by default, and then the push plugin is left out of the native projects.

- iOS needs only the flag: `aps-environment` entitlement, the `AppDelegate` hooks, and the Push
  Notifications capability on the bundle id (`asc.mjs ensure-bundle-id --push`).
- Android uses Firebase and also needs the Firebase config of that application id:
  `--google-services <google-services.json>` locally, the `GOOGLE_SERVICES_JSON_B64` secret in
  CI. Without a config that lists the app, Android is built without the plugin, because the
  plugin crashes the app on `register()` when Firebase is not configured. The shared CI config
  only covers the apps registered in it, so an app missing there is built without push; a file
  given with `--google-services` that does not list the app fails the generation. The file must
  not be committed.
- The published page calls Capacitor's `PushNotifications` plugin through the bridge; the
  generated project has an example in `app-snippet/push-example.html`.

## Workflows

The jobs that read the `stores` secrets on Linux (`version` and `android` in `shell.yml`, and
`asc-info.yml`) run on the org's `mitra-delivery` runner group, which has no Android SDK: the
Android job installs it (`android-actions/setup-android`). `ci.yml` runs on `mitra-ci`. iOS runs on
`MACOS_RUNNER` (default `macos-26`).

### App shell (`shell.yml`)

Manual run, one app per run: generates the shell, builds Android (signed AAB and APK, optional
Play upload) and iOS (unsigned device build, or cloud-signed archive uploaded to TestFlight).
The build number is resolved once, in its own job before both builds: one above the highest build
in App Store Connect and the highest versionCode in any Play track, and never below the run number,
so both stores get the same, always increasing number. A run that uploads to a store whose history
cannot be read stops, unless `build_number` is given.

| Input | Default | Meaning |
|---|---|---|
| `app` | empty | Platform app UUID |
| `api` | `https://beta.mitralab.io` | Platform API base URL |
| `url` | empty | Published URL, when there is no app UUID |
| `app_id` | empty | Override the application id and bundle id |
| `version` | `1.0` | Marketing version |
| `build_number` | empty | Override the build number |
| `associated_domains` | `true` | Declare `applinks` and `webcredentials` on iOS |
| `push` | `false` | Generate with `--push` |
| `upload_testflight` | `false` | Archive, upload to TestFlight and add the build to the group |
| `testflight_group` | `Mitra shell testers` | TestFlight group that receives the build |
| `upload_play` | `true` | Upload the AAB when the service account secret exists |
| `play_track` | `internal` | Play track for the upload |

Secrets: `ANDROID_KEYSTORE_B64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`,
`PLAY_SERVICE_ACCOUNT_JSON_B64`, `GOOGLE_SERVICES_JSON_B64`, `ASC_KEY_ID`, `ASC_ISSUER_ID`,
`ASC_KEY_P8_B64`, `APPLE_TEAM_ID`. Without the keystore the Android build is unsigned; without
the Play service account the upload is skipped with a warning.

The store secrets live in the `stores` environment of the repository, not at repository level:
the jobs that read them declare `environment: stores`. Restrict that environment to the `main`
branch (deployment branches), so a workflow changed on another branch cannot read them.

### ASC tools (`asc-info.yml`)

Manual run: prints what App Store Connect has for a bundle id and does small TestFlight chores.

| Input | Meaning |
|---|---|
| `bundle_id` (required) | Bundle id to inspect |
| `build` with `group` | Add that build to that TestFlight group |
| `copy_testers_from` | Bundle id whose internal testers are copied to `bundle_id` |
| `expire` | Build number to expire in TestFlight |

Secrets, from the `stores` environment: `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8_B64`.

### Push smoke test (`push-smoke-ios.yml`)

Manual run: generates a shell with `--push`, builds it for the iOS simulator and delivers a
notification with `simctl push`; the run fails when the page does not receive it. Inputs: `app`
(required, platform app UUID used for the identity) and `api`. Reads no secret.

### CI (`ci.yml`)

Runs on pull requests and on `main`. `test` runs `npm test` (syntax check of the generator
scripts and their self-tests). `build` generates a shell from a local fixture page, without the
platform API or any secret, and checks the generated project, including the icon drawn from the
initials; it does not run Gradle.

### Workflow of the generated project

`generator/templates/github/mobile.yml` is copied to `.github/workflows/mobile.yml` of every
generated project, for when that project lives in its own repository. It reads
`ANDROID_KEYSTORE_B64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`, `ASC_KEY_ID`,
`ASC_ISSUER_ID`, `ASC_KEY_P8_B64` and `APPLE_TEAM_ID`.

## Known limits

- Three steps stay manual in each store account: creating the app record in App Store Connect
  (no public API), creating the app and uploading its first AAB in Play Console, and creating
  the Play service account key.
- Cloud signing needs an App Store Connect API key with the Admin role; an App Manager key
  archives but fails on export.
- App Store Connect only accepts builds made with the iOS 26 SDK, hence the `macos-26` runner.
- The shell loads the published URL; offline it shows a fallback page only. An App Store
  submission still has to meet the store rules for apps that are mostly a WebView.
- Sign-in works only when the published app starts it in redirect mode inside the shell and, for
  `--callback scheme`, carries the return snippet.
- `--callback https` on iOS needs iOS 17.4 or later; below that the sign-in opens in the system
  browser. The platform does not write the association files on publish yet, so they are an
  operator copy that the next publish of the app can remove.
- For apps installed from Google Play, `assetlinks.json` must list the Play App Signing
  certificate, not only the upload key.
- Push: sending is not in this repo (it takes an APNs key and a Firebase service account), and
  delivery with real credentials has not been exercised on either platform.
