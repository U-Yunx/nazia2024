/**
 * Bootstrap the browser the Playwright CLI drives.
 *
 * The dev image (node:20-alpine) ships no system Chrome/Chromium, and
 * `playwright-cli` defaults to the Google Chrome *channel* — which fails with
 * "channel chrome not found" the first time anyone opens the preview for a
 * screenshot or a smoke test. `.playwright/cli.config.json` therefore selects
 * the Playwright-managed Firefox build, and this script makes sure that build
 * is actually present.
 *
 * Deliberately forgiving: it never fails the install, it skips entirely in CI
 * (where the build only needs vite) and when browser downloads are disabled,
 * and it exits immediately once the browser is cached, so repeat installs cost
 * nothing.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG = "[ensure-test-browser]";

if (process.env.CI || process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD) {
  process.exit(0);
}

// Playwright stores downloads here by default; honour an override if set.
const cacheDir =
  process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache", "ms-playwright");

function firefoxInstalled() {
  try {
    if (!existsSync(cacheDir)) return false;
    return readdirSync(cacheDir).some((entry) => entry.startsWith("firefox"));
  } catch {
    return false;
  }
}

if (firefoxInstalled()) {
  process.exit(0);
}

const bin = join("node_modules", ".bin", "playwright-cli");
if (!existsSync(bin)) {
  // Dependencies are not laid down yet (or the CLI is not a dependency) — the
  // preview still runs, so this is not an error.
  process.exit(0);
}

console.log(`${LOG} Installing the Playwright Firefox build for browser testing…`);
const res = spawnSync(bin, ["install-browser", "firefox"], {
  stdio: "inherit",
  timeout: 300_000,
});

if (res.error || res.status !== 0) {
  console.warn(
    `${LOG} Could not install the Firefox build (${res.error?.message ?? `exit ${res.status}`}). ` +
      `Browser tests may need PLAYWRIGHT_EXECUTABLE_PATH set to a local browser.`,
  );
}

// Never block or fail `npm install` over a test-only browser.
process.exit(0);
