/**
 * Shared plumbing for the ANA24 Android release pipeline.
 *
 * Used by:
 *   - scripts/android-signing.mjs  → keystore + Gradle signing config
 *   - scripts/publish-apk.mjs      → publish the built APK into public/downloads
 *
 * Both run from the project root and resolve paths against `process.cwd()`,
 * matching the other scripts here (see scripts/check-deploy-env.mjs).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/* -------------------------------- Paths ---------------------------------- */

export const ANDROID_DIR = 'android'
export const APP_DIR = join(ANDROID_DIR, 'app')
export const BUILD_GRADLE = join(APP_DIR, 'build.gradle')
export const SIGNING_GRADLE = join(APP_DIR, 'ana24-signing.gradle')
export const KEYSTORE_PROPERTIES = join(ANDROID_DIR, 'keystore.properties')
export const DEFAULT_KEYSTORE = join(ANDROID_DIR, 'ana24-release.keystore')

/** Where the site serves the published APK from (copied into dist/ by Vite). */
export const DOWNLOAD_DIR = join('public', 'downloads')
export const MANIFEST_FILE = join(DOWNLOAD_DIR, 'latest.json')

/** Android application ID — must stay in sync with capacitor.config.ts. */
export const APP_ID = 'com.ana24.trader'

/** Gradle output directories, relative to the project root. */
export const APK_DIRS = {
  release: join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', 'release'),
  debug: join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', 'debug'),
}

/* ------------------------------- Versions -------------------------------- */

export function readPackageJson() {
  return JSON.parse(readFileSync('package.json', 'utf8'))
}

/**
 * The version the APK was actually stamped with. android-signing.mjs writes the
 * package.json version into android/app/build.gradle, so read it back from
 * there when it exists — that guarantees the download manifest matches the
 * version displayed by Android in the app's info screen. Falls back to
 * package.json for a dry run before the native project exists.
 */
export function readAppVersion() {
  if (existsSync(BUILD_GRADLE)) {
    const match = readFileSync(BUILD_GRADLE, 'utf8').match(/versionName\s+"([^"]+)"/)
    if (match?.[1]) return match[1]
  }
  return readPackageJson().version
}

/**
 * "1.2.3" -> 10203. Monotonic in the semantic version triple, which is what
 * Android requires for upgrades (it refuses an APK with a lower versionCode).
 */
export function toVersionCode(version) {
  const parts = String(version)
    .split(/[.\-+]/)
    .slice(0, 3)
    .map((n) => Number.parseInt(n, 10))
  const safe = (n) => (Number.isFinite(n) && n > 0 ? n : 0)
  const [major, minor, patch] = [safe(parts[0]), safe(parts[1]), safe(parts[2])]
  return major * 10000 + minor * 100 + patch
}

/* -------------------------------- Helpers -------------------------------- */

export function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  const mb = bytes / 1024 / 1024
  if (mb >= 1) return `${mb.toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** Every .apk sitting in a Gradle output directory (may be empty). */
export function listApks(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.apk'))
    .map((name) => join(dir, name))
}

/**
 * Keystore credentials written by android-signing.mjs. This is a plain
 * java.util.Properties file — parsed loosely here so the script never needs a
 * Gradle/JVM round-trip just to read four values back.
 */
export function readKeystoreProperties(file = KEYSTORE_PROPERTIES) {
  if (!existsSync(file)) return {}
  const out = {}
  for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('!')) continue
    const index = line.indexOf('=')
    if (index === -1) continue
    out[line.slice(0, index).trim()] = line.slice(index + 1).trim()
  }
  return out
}
