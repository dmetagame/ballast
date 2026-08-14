#!/usr/bin/env node
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = fileURLToPath(new URL(".", import.meta.url));
const dist = join(here, "dist");
const remote = process.env.BASE_URL?.replace(/\/$/, "");
if (!remote && !existsSync(join(dist, "index.html"))) throw new Error("run `npm run build` first");

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const server = createServer((request, response) => {
  const requestPath = request.url.split("?")[0];
  const file = join(dist, requestPath === "/" ? "index.html" : requestPath);
  if (!file.startsWith(dist) || !existsSync(file)) return response.writeHead(404).end();
  response.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
  response.end(readFileSync(file));
});

let base = remote;
if (!remote) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}

const checks = [];
const check = (name, pass, detail = "") => {
  checks.push({ name, pass });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
};

async function navigate(page, url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await page.goto(url, { waitUntil: "networkidle" });
    } catch (error) {
      lastError = error;
      if (!remote || attempt === 3) throw error;
      await page.waitForTimeout(attempt * 1_000);
    }
  }
  throw lastError;
}

const browser = await chromium.launch();
for (const [name, viewport] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
  const page = await browser.newPage({ viewport });
  await navigate(page, base);
  check(`${name}: no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth === innerWidth));
  check(`${name}: controlled beta is visible`, await page.locator(".notice-amber").isVisible());
  check(`${name}: dry-run warning is explicit`, (await page.locator(".notice-amber").innerText()).includes("Do not rely on Ballast"));
  check(`${name}: conservative defaults are rendered`, await page.locator('#triggerHealth[value="1.15"]').isVisible() && await page.locator('#maxCollateral[value="100"]').isVisible());
  check(`${name}: transaction controls start disabled`, await page.locator("#authorizeButton").isDisabled() && await page.locator("#policyButton").isDisabled());
  check(`${name}: atomic custody wording is visible`, (await page.locator(".flow-card .body-copy").innerText()).includes("one atomic transaction"));
  await page.locator("#connectButton").click();
  check(`${name}: missing wallet is handled`, (await page.locator("#statusMessage").innerText()).includes("Install a wallet"));
  await page.close();
}
await browser.close();
if (!remote) server.close();

const failed = checks.filter((result) => !result.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exitCode = 1;
