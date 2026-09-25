#!/usr/bin/env node
/**
 * Preflight for the `apk:*` scripts.
 *
 * A missing JDK or Android SDK turns `./gradlew assembleRelease` into a wall of
 * Java/Gradle noise that never says what to install. This runs first and fails
 * with one plain-language paragraph instead.
 *
 * Checks:
 *   1. a JDK is installed, and new enough (Capacitor 8 targets JDK 21)
 *   2. keytool is reachable — it ships with the JDK and signs the release APK
 *   3. the Android SDK can be found (ANDROID_HOME / ANDROID_SDK_ROOT / defaults)
 *
 * Exit 0 = ready to build. Exit 1 = not ready, with the fix spelled out.
 * Writes nothing; safe to run any time.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const log = (message) => console.log(`[check-android-env] ${message}`)
const warn = (message) => console.warn(`[check-android-env] WARNING: ${message}`)
const fail = (message) => {
  console.error(`[check-android-env] ${message}`)
  process.exit(1)
}

const JDK_HARD_MINIMUM = 17
const JDK_RECOMMENDED = 21 // what Capacitor 8 is built against
const isWindows = process.platform === 'win32'

/* -------------------------------- 1. The JDK ------------------------------ */

function findJava() {
  const candidates = []
  if (process.env.JAVA_HOME) candidates.push(join(process.env.JAVA_HOME, 'bin', isWindows ? 'java.exe' : 'java'))
  candidates.push('java')

  for (const java of candidates) {
    const result = spawnSync(java, ['-version'], { encoding: 'utf8' })
    if (result.error || result.status !== 0) continue
    // `java -version` prints to stderr, and the format has changed over the
    // years ("1.8.0_392" vs "21.0.5") — parse both.
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`
    const match = text.match(/version\s+"([^"]+)"/)
    if (!match) continue
    const raw = match[1]
    const digits = raw
      .split(/[.\-_+]+/)
      .map((part) => Number.parseInt(part, 10))
      .filter((part) => Number.isFinite(part))
    const major = digits[0] === 1 ? digits[1] : digits[0]
    return { java, raw, major: major ?? 0 }
  }
  return null
}

const jdk = findJava()

if (!jdk) {
  fail(
    'No JDK found on PATH (or via JAVA_HOME), so Gradle cannot run.\n' +
      '  Install JDK 21 — the easiest route bundles everything else too:\n' +
      '    • Android Studio (includes a JDK + the Android SDK): https://developer.android.com/studio\n' +
      '    • or sdkman:  sdk install java 21-tem\n' +
      '    • or Homebrew: brew install openjdk@21\n' +
      '  Then re-run the same command.',
  )
}

if (jdk.major < JDK_HARD_MINIMUM) {
  fail(
    `Found Java ${jdk.raw}, which is too old to build Android app bundles (needs JDK ${JDK_HARD_MINIMUM}+).\n` +
      '  Install JDK 21 and make sure it is the active java on PATH, then re-run.',
  )
}

if (jdk.major < JDK_RECOMMENDED) {
  warn(
    `Found Java ${jdk.raw}. It may still build, but Capacitor 8 officially targets ` +
      `JDK ${JDK_RECOMMENDED} — installing that avoids obscure Gradle errors.`,
  )
}

log(`JDK ${jdk.raw} — ${jdk.java}`)

/* ------------------------------ 2. keytool -------------------------------- */

function findKeytool() {
  if (jdk.java !== 'java') {
    const sibling = join(dirname(jdk.java), isWindows ? 'keytool.exe' : 'keytool')
    if (existsSync(sibling)) return sibling
  }
  const result = spawnSync('keytool', ['-help'], { stdio: 'ignore' })
  if (!result.error && result.status === 0) return 'keytool'
  return null
}

const keytool = findKeytool()

if (!keytool) {
  fail(
    'keytool was not found, so the release APK could not be signed.\n' +
      '  keytool ships with every JDK — if the JDK is installed, put its bin/ directory on PATH\n' +
      '  (or set JAVA_HOME) and re-run.',
  )
}

log(`keytool found — ${keytool}`)

/* --------------------------- 3. The Android SDK --------------------------- */

function findAndroidSdk() {
  for (const name of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    const value = process.env[name]
    if (value && existsSync(value)) return { root: value, source: name }
  }

  const home = homedir()
  const defaults = [
    join(home, 'Library', 'Android', 'sdk'), // macOS (Android Studio default)
    join(home, 'Android', 'Sdk'), // Linux (Android Studio default)
    join(home, 'AppData', 'Local', 'Android', 'Sdk'), // Windows (Android Studio default)
  ]
  for (const candidate of defaults) {
    if (existsSync(candidate)) return { root: candidate, source: 'Android Studio default' }
  }
  return null
}

const sdk = findAndroidSdk()

if (!sdk) {
  fail(
    'Android SDK not found, so Gradle has nowhere to compile against.\n' +
      '  Install Android Studio (https://developer.android.com/studio) and open it once so it\n' +
      '  provisions the SDK, then either use its default location or set ANDROID_HOME to your\n' +
      '  SDK directory (e.g. ~/Library/Android/sdk on macOS, ~/Android/Sdk on Linux).\n' +
      '  Re-run this command afterwards.',
  )
}

log(`Android SDK — ${sdk.root} (${sdk.source})`)

const subdir = (name) => (existsSync(join(sdk.root, name)) ? readdirSync(join(sdk.root, name)) : [])

if (subdir('platforms').filter((entry) => entry.startsWith('android-')).length === 0) {
  warn(
    'no platforms/android-* installed. Gradle will try to download one — if that fails, open the ' +
      'SDK Manager in Android Studio (or run: sdkmanager --licenses) and accept the licenses.',
  )
}

if (subdir('build-tools').length === 0) {
  warn(
    'no build-tools/ installed. Gradle will try to download them — if that fails, install them from ' +
      'the SDK Manager in Android Studio (or run: sdkmanager --licenses) and accept the licenses.',
  )
}

/* --------------------------------- Done ----------------------------------- */

log('')
log('Environment is ready to build the APK — JDK ✓  keytool ✓  Android SDK ✓')
log('Next: npm run apk:release    (or npm run apk:publish to also publish the download)')
