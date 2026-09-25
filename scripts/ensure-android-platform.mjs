#!/usr/bin/env node
/**
 * Guarantee the native `android/` project exists before any Gradle step.
 *
 * `cap add android` generates the android/ Gradle project. It has to run
 * *before* android-signing.mjs, which edits android/app/build.gradle — otherwise
 * the release pipeline dies on a fresh checkout with
 * "No android/ project found".
 *
 * Idempotent: if android/ is already present this does nothing, so it is safe to
 * run on every build.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const log = (message) => console.log(`[ensure-android-platform] ${message}`)
const fail = (message) => {
  console.error(`[ensure-android-platform] ${message}`)
  process.exit(1)
}

if (existsSync('android')) {
  log('android/ already exists — nothing to do.')
  process.exit(0)
}

log('No android/ project yet — generating it with "npx cap add android" …')

// `--yes` keeps npx from pausing on an install prompt in a non-interactive run.
const result = spawnSync('npx', ['--yes', 'cap', 'add', 'android'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

if (result.error || result.status !== 0) {
  fail(
    '"npx cap add android" failed (see the output above). The usual causes:\n' +
      '  • @capacitor/cli or @capacitor/android is missing from node_modules — run: npm install\n' +
      '  • no network access, so the platform template could not be fetched\n' +
      'Fix that and re-run the same command — this step will pick up where it left off.',
  )
}

log('android/ generated. The signing step will now have a Gradle project to patch.')
