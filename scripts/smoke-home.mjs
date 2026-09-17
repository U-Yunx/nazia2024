/**
 * Smoke test that loads the app's Home route in a real Chromium browser and
 * fails on any console/page/network error — the exact class of failure that
 * surfaces as "Failed to fetch dynamically imported module: .../Home.tsx".
 *
 * Usage:  node scripts/smoke-home.mjs [baseUrl]
 *   baseUrl defaults to http://localhost:5173/
 *
 * Uses playwright-core (a devDependency) and resolves a real Chrome/Chromium
 * binary at runtime: PLAYWRIGHT_EXECUTABLE_PATH, then common system paths,
 * then the default playwright-managed install. This keeps the script working
 * in sandboxes that only ship a system browser.
 */
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://localhost:5173/";

const candidates = [
  process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

const executablePath = candidates.find((p) => existsSync(p));

if (!executablePath) {
  console.error(
    "[smoke-home] No Chrome/Chromium binary found. Set PLAYWRIGHT_EXECUTABLE_PATH " +
      "or run `npx playwright install chromium`.",
  );
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});

const page = await browser.newPage();
const errors = [];

page.on("console", (m) => {
  if (m.type() === "error") errors.push(`[console.error] ${m.text()}`);
});
page.on("pageerror", (e) => errors.push(`[pageerror] ${e.stack ?? e.message}`));
page.on("requestfailed", (r) => {
  const failure = r.failure();
  if (failure) errors.push(`[requestfailed] ${r.url()} :: ${failure.errorText}`);
});

try {
  await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
} catch (e) {
  errors.push(`[goto] ${e.message}`);
}
await page.waitForTimeout(2500);

const info = await page.evaluate(() => ({
  title: document.title,
  heading: document.querySelector("h1")?.textContent ?? "",
  text: (document.body?.innerText ?? "").slice(0, 160).replace(/\s+/g, " "),
}));

console.log("URL    :", page.url());
console.log("TITLE  :", info.title);
console.log("HEADING:", info.heading);
console.log("BODY   :", info.text);
console.log("ERRORS :", errors.length ? `\n${errors.join("\n")}` : "none");

await browser.close();
process.exit(errors.length ? 1 : 0);