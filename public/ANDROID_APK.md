# ANA24 — Build an Android APK (Capacitor)

This app is a Vite + React web app. Capacitor wraps the production web build
(`dist/`) into a native Android project so it can be packaged as an APK and run
offline inside the system WebView — same UI, same behaviour as the web app.

The repo is already prepared: `@capacitor/core`, `@capacitor/cli` and
`@capacitor/android` are installed, `capacitor.config.ts` exists, and npm
scripts are wired up. The Android **native project is generated on your
machine** (step 4) — it is not committed, because the APK itself can only be
built on a machine with an Android SDK.

---

## 1. Environment file (public values)

The Supabase URL and anon key are **public** values (they ship in the browser
bundle of the deployed web app). For a local APK build, create `.env.local`
in the project root with the same values the hosted environments use:

```
VITE_SUPABASE_URL=https://xopygzpepikerwqxzqzu.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhvcHlnenBlcGlrZXJ3cXh6cXp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc5ODYzMzMsImV4cCI6MjEwMzU2MjMzM30.8jh0Ux_fcb-LJGqtUZVAUqN9fHDNHSffsKlLndzSLzk
```

These get baked into the bundle at `npm run build` time via `import.meta.env`.
No deploy-only secrets (Cloudflare tokens) are needed for APK builds — leave
them out.

---

## 2. Prerequisites (one-time)

- **Node.js 20.19+** (Vite 7 requirement)
- **JDK 17 or newer** — Android Studio bundles one; or install Temurin/OpenJDK
- **Android SDK** — install [Android Studio](https://developer.android.com/studio),
  then in *SDK Manager* install: *Android SDK Platform 35*, *Build-Tools 35*,
  *Android SDK Command-line Tools*
- Set `ANDROID_HOME` if the SDK isn't at the default location
  (`~/Android/Sdk` on macOS/Linux, `%LOCALAPPDATA%\Android\Sdk` on Windows)

---

## 3. Install dependencies

```bash
npm install
```

---

## 4. Generate the Android native project

```bash
npm run cap:add:android
```

Runs `cap add android`, creating the `android/` folder. The web build must
exist first (the script builds before syncing, or run `npm run build`
yourself). Repeat this once per machine/checkout — it is a local artifact.

---

## 5. Sync the web build into the native project

```bash
npm run build      # fresh dist/ from current source
npm run cap:sync   # copies dist/ → android/app/src/main/assets/public
```

---

## 6. Build the APK

**Debug APK** (installable, no signing config needed):

```bash
npm run apk:debug
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`

**Release APK** (unsigned):

```bash
npm run apk:release
```

Output: `android/app/build/outputs/apk/release/app-release-unsigned.apk`

On Windows, `./gradlew` becomes `gradlew.bat` — run the gradle command from
`android/` directly, or use Android Studio instead.

---

## 7. Install / test

- Copy the debug APK to a phone and open it (allow "install unknown apps"),
  or run `./gradlew installDebug` from `android/` with a device connected
- Or open the project in Android Studio: `npm run cap:open:android`, pick a
  device/emulator, press Run ▶

---

## Signing for the Play Store

`app-release-unsigned.apk` must be signed before distribution:

1. Create a keystore: `keytool -genkey -v -keystore ana24.keystore -alias ana24 -keyalg RSA -keysize 2048 -validity 10000`
2. Add to `android/app/build.gradle` (or `~/.gradle/gradle.properties`) the
   `storeFile`, `storePassword`, `keyAlias`, `keyPassword`
3. `cd android && ./gradlew assembleRelease` → now a signed release APK

**Keep the keystore safe** — losing it means you can never update the app
under the same package name.

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
