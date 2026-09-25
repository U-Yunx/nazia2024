# ANA24 — Build an Android APK (Capacitor)

This app is a Vite + React web app. Capacitor wraps the production web build
(`dist/`) into a native Android project so it can be packaged as an APK and run
offline inside the system WebView — same UI, same behaviour as the web app.

The repo is already prepared: `@capacitor/core`, `@capacitor/cli` and
`@capacitor/android` are installed, `capacitor.config.ts` exists and the npm
scripts below are wired up. The Android **native project is generated on your
machine** — it is not committed, because an APK can only be built on a machine
with an Android SDK.

---

## Fast path — one command

```bash
npm run apk:publish
```

That single command verifies the toolchain, creates the release keystore on
first run, signs, builds and **publishes the APK as a download on this site**.
The first run needs the steps in *Prerequisites* and *Generate the native
project* below; after that `apk:publish` is all you ever run.

What it leaves behind:

| Output | Purpose |
|---|---|
| `public/downloads/ana24-<version>.apk` | The published download. Commit it and deploy. |
| `public/downloads/latest.json` | Release manifest the site reads — this is what makes the download buttons appear. |
| `android/app/build/outputs/apk/release/app-release.apk` | The signed APK Gradle produced. |
| `android/ana24-release.keystore` + `android/keystore.properties` | Signing identity. **Git-ignored — back both up.** |

The Help page and the landing-page *Get the Android app* CTA read the manifest
at runtime, so they switch from build instructions to a real *Download APK*
button on their own — no code change, no cache busting.

---

## 1. Environment file (public values)

The Supabase URL and anon key are **public** values (they ship in the browser
bundle of the deployed web app). For a local APK build, create `.env.local`
in the project root with the same values the hosted environments use:

```
VITE_SUPABASE_URL=https://xopygzpepikerwqxzqzu.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhvcHlnenBlcGlrZXJ3cXh6cXp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc5ODYzMzMsImV4cCI6MjEwMzU2MjMzM30.8jh0Ux_fcb-LJGqtUZVAUqN9fHDNHSffsKlLndzSLzk
```

These get baked into the bundle at build time via `import.meta.env`. No
deploy-only secrets (Cloudflare tokens, service keys) are needed for APK builds —
leave them out.

---

## 2. Prerequisites (one-time)

- **Node.js 20.19+** (Vite 7 requirement)
- **JDK 17 or newer** — Android Studio bundles one; also provides `keytool`
- **Android SDK** — install [Android Studio](https://developer.android.com/studio),
  then in *SDK Manager* install: *Android SDK Platform 35*, *Build-Tools 35*,
  *Android SDK Command-line Tools*
- Set `ANDROID_HOME` if the SDK isn't at the default location
  (`~/Android/Sdk` on macOS/Linux, `%LOCALAPPDATA%\Android\Sdk` on Windows)

---

## 3. Install dependencies and generate the native project

```bash
npm install
npm run cap:add:android   # once per machine/checkout — creates android/
```

---

## 4. Build and publish

```bash
npm run apk:publish
```

Gradle signs the release build with `android/app/ana24-signing.gradle`, which the
signing script generates and `build.gradle` applies. There is nothing to
hand-edit. Then commit and deploy:

```bash
git add public/downloads && git commit -m "Publish Android build"
```

On Windows `./gradlew` is `gradlew.bat`: run the Gradle step from `android/`
directly, or open the project in Android Studio (`npm run cap:open:android`) and
use *Build → Generate Signed App Bundle / APK*.

---

## Signing — what the scripts do for you

`npm run apk:signing` (also run automatically by `apk:release` / `apk:publish`):

1. creates `android/ana24-release.keystore` with `keytool` if there isn't one
2. writes the credentials to `android/keystore.properties` (**git-ignored**)
3. generates `android/app/ana24-signing.gradle`, which re-opens the `android {}`
   block to attach `signingConfigs.release`
4. appends one `apply from:` line to `android/app/build.gradle`
5. stamps `versionName`/`versionCode` from `package.json`

Overridable when the keystore should live elsewhere or already exists:

| Variable | Default |
|---|---|
| `ANA24_KEYSTORE` | `android/ana24-release.keystore` |
| `ANA24_KEY_ALIAS` | `ana24` |
| `ANA24_KEYSTORE_PASSWORD` | generated once, then reused from `keystore.properties` |

Every step is idempotent: re-running never regenerates a keystore or duplicates
the Gradle hook.

**Keep the keystore and `keystore.properties` safe** (e.g. a password manager
plus an encrypted backup). Losing them means you can never ship an update under
`com.ana24.trader` again. Bump `package.json`'s `version` for each release —
`versionCode` is derived from it (`1.2.3` → `10203`) and Android rejects an APK
whose code is lower than the installed one.

---

## Checking a build without publishing it

```bash
npm run apk:debug     # installable debug APK, no signing config
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`. Debug builds are
never published by accident — the publisher rejects an
`app-release-unsigned.apk`, and a debug build needs an explicit
`node scripts/publish-apk.mjs --allow-debug`.

Install by copying the APK to a phone and opening it (allow *install unknown
apps*), or `./gradlew installDebug` from `android/` with a device connected.

---

## Play Store (optional)

For Google Play you upload an **AAB**, not an APK:

```bash
cd android && ./gradlew bundleRelease
```

It is signed with the same config and lands in
`android/app/build/outputs/bundle/release/app-release.aab`. Google Play App
Signing then re-signs it with the distribution key; the keystore here becomes the
*upload key*, so keep it — Play requires the same upload key for every release.

---

## Config reference (`capacitor.config.ts`)

| Key | Value | Notes |
|---|---|---|
| `appId` | `com.ana24.trader` | Android application ID. **Never change after first release** (Play treats it as a new app). |
| `appName` | `ANA24` | Launcher label. |
| `webDir` | `dist` | Vite output directory. |
| `android.allowMixedContent` | `false` | All traffic is HTTPS. |

Replace the default Capacitor launcher icons under
`android/app/src/main/res/mipmap-*` with branded ANA24 icons before release.

---

## Android-specific notes

- **Supabase auth inside the WebView:** the app origin is `https://localhost`
  in the WebView. Email-confirmation links redirect to the URL configured in
  Supabase Auth → *Redirect URLs*; add `https://localhost` there if you want
  confirmation links to land back inside the app.
- **Deep links / cold start on a nested route:** navigation is client-side
  (React Router `BrowserRouter`), so in-app navigation is fine. If a cold
  start ever lands on a deep route with a blank screen, switch the router to
  hash mode (`createHashRouter` from `react-router-dom`) — a one-line change
  in `src/App.tsx` — which makes every route resolvable from a local file.
- **Background trading:** the app's trading runs in the WebView (and via the
  Supabase `robot-runner` edge function for background runs), so switching
  tabs or minimising the app doesn't stop a running robot.
- **Offline shell:** the whole `dist/` build (including `downloads/latest.json`)
  is packaged inside the APK, so the app opens without a network and the Android
  card still knows which version it is.
