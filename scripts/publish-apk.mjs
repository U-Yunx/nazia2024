#!/usr/bin/env node
/**
 * Publish a built APK as a real download on the site.
 *
 * Copies the signed release APK into `public/downloads/` and writes the
 * manifest the app reads at runtime (`public/downloads/latest.json`). Vite
 * copies public/ into dist/, so the file is served by the deployed site and
 * also ships inside the WebView offline build.
 *
 * The Help page and the landing-page CTA switch themselves on from the manifest
 * — no code change, no cache-busting, nothing to keep in sync by hand. If the
 * manifest says `available: false` (the committed default), those surfaces show
 * a "not published yet" note with a contact link instead of a dead download.
 *
 * Usage:
 *   node scripts/publish-apk.mjs                # release APK only (default)
 *   node scripts/publish-apk.mjs --allow-debug  # publish a debug build (testing)
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  APK_DIRS,
  DOWNLOAD_DIR,
  MANIFEST_FILE,
  humanBytes,
  listApks,
  readAppVersion,
  toVersionCode,
} from './lib/android-release.mjs'

const log = (message) => console.log(`[publish-apk] ${message}`)
const fail = (message) => {
  console.error(`[publish-apk] ${message}`)
  process.exit(1)
}

const allowDebug = process.argv.includes('--allow-debug')

/* ---------------------------- 1. Find the APK ----------------------------- */

function pickReleaseApk() {
  const apks = listApks(APK_DIRS.release)
  if (apks.length === 0) return { apk: null, unsigned: null }
  // The default single-APK output is app-release.apk; anything *-unsigned.apk
  // means the Gradle signing config was never applied.
  const signed = apks.find((p) => /(^|\/)app-release\.apk$/.test(p))
  if (signed) return { apk: signed, unsigned: null }
  const unsigned = apks.find((p) => p.includes('unsigned'))
  return { apk: null, unsigned: unsigned ?? null }
}

let apkPath
let kind

if (allowDebug) {
  const debugApk = listApks(APK_DIRS.debug).find((p) => p.endsWith('app-debug.apk'))
  if (!debugApk) {
    fail(`No debug APK found in ${APK_DIRS.debug}/. Run "npm run apk:debug" first.`)
  }
  apkPath = debugApk
  kind = 'debug'
} else {
  const { apk, unsigned } = pickReleaseApk()
  if (unsigned) {
    fail(
      `Found only ${unsigned}, which is unsigned and will not install on a phone.\n` +
        '  Run "npm run apk:release" (or "npm run apk:publish") so the signing config in\n' +
        '  android/app/ana24-signing.gradle is applied, then publish again.',
    )
  }
  if (!apk) {
    fail(
      `No release APK found in ${APK_DIRS.release}/.\n` +
        '  Run "npm run apk:release" first — or "npm run apk:publish", which does the whole\n' +
        '  pipeline (verify → sign → build → publish) in one step.',
    )
  }
  apkPath = apk
  kind = 'release'
}

/* ------------------------- 2. Sanity-check the file ----------------------- */

const apk = readFileSync(apkPath)
const sizeBytes = apk.byteLength

if (sizeBytes < 1024 || apk.subarray(0, 2).toString('latin1') !== 'PK') {
  fail(`${apkPath} is not a valid APK (no ZIP header). Re-run the Gradle build.`)
}

if (sizeBytes < 500 * 1024) {
  log(`WARNING: ${apkPath} is only ${humanBytes(sizeBytes)} — that looks too small for a real build.`)
}

// Android signs APKs with the v2/v3 scheme by default for minSdk >= 24; the
// signature block carries this literal marker. A v1-only signature would not,
// so treat a miss as a warning rather than a failure.
const signed = apk.includes(Buffer.from('APK Sig Block 42', 'latin1'))
if (!signed) {
  log('WARNING: no v2/v3 signature block found. Verify with `apksigner verify` before shipping.')
}

/* --------------------------- 3. Publish the file -------------------------- */

const version = readAppVersion()
const versionCode = toVersionCode(version)
const fileName = `ana24-${version}${kind === 'debug' ? '-debug' : ''}.apk`
const target = join(DOWNLOAD_DIR, fileName)

mkdirSync(DOWNLOAD_DIR, { recursive: true })

// One published build at a time: drop older binaries so the repo (and the
// deployed bundle) never carries a stale APK that nobody links to.
for (const entry of existsSync(DOWNLOAD_DIR) ? readdirSync(DOWNLOAD_DIR) : []) {
  if (entry.endsWith('.apk') && entry !== fileName) {
    rmSync(join(DOWNLOAD_DIR, entry))
    log(`Removed the previous build: ${entry}`)
  }
}

copyFileSync(apkPath, target)

const sha256 = createHash('sha256').update(apk).digest('hex')
const builtAt = new Date(statSync(apkPath).mtimeMs).toISOString()

const manifest = {
  available: true,
  generatedAt: new Date().toISOString(),
  release: {
    file: fileName,
    version,
    versionCode,
    sizeBytes,
    sha256,
    builtAt,
    signed,
    kind,
  },
}

writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`)

/* ------------------------------- Summary --------------------------------- */

log('')
log(`Published ${fileName}`)
log(`  version    ${version} (versionCode ${versionCode})`)
log(`  size       ${humanBytes(sizeBytes)}`)
log(`  sha256     ${sha256}`)
log(`  served at  /downloads/${fileName}`)
log(`  manifest   ${MANIFEST_FILE}`)
log('')
log('Next: commit public/downloads/ and deploy — the Help page and the landing-page')
log('CTA pick the download up automatically from the manifest.')
