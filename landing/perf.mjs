#!/usr/bin/env node
// Frame timing while scrolling the whole page, unthrottled and at 4x CPU throttle.
//
//   npm run build && npm run perf
//
// Drives the scroll from requestAnimationFrame and records the interval between frames, so
// every ScrollTrigger update is exercised the way a reader's scroll would exercise it.
//
// Read the output as indicative rather than authoritative: headless Chromium is not
// vsync-locked to a display, so absolute fps is softer evidence than the shape of the
// distribution and the comparison between the two runs.

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const dist = join(fileURLToPath(new URL(".", import.meta.url)), "dist");
if (!existsSync(join(dist, "index.html"))) throw new Error("run `npm run build` first");

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer((req, res) => {
  const path = req.url.split("?")[0];
  const file = join(dist, path === "/" ? "index.html" : path);
  if (!file.startsWith(dist) || !existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const rows = [];

for (const { label, rate } of [
  { label: "unthrottled", rate: 1 },
  { label: "4x CPU throttle", rate: 4 },
]) {
  // A mid-tier phone viewport for both runs, so the only variable between them is CPU.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });

  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);

  const intervals = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const samples = [];
        let last = performance.now();
        const step = () => {
          const now = performance.now();
          samples.push(now - last);
          last = now;
          window.scrollBy(0, 24);
          const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4;
          if (atBottom || samples.length > 2000) return resolve(samples.slice(1));
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
  );

  const sorted = [...intervals].sort((a, b) => a - b);
  const at = (q) => sorted[Math.floor(sorted.length * q)];
  // A frame that took longer than two 60Hz intervals missed at least one vsync.
  const dropped = intervals.filter((d) => d > 33.4).length;

  rows.push({
    label,
    frames: intervals.length,
    median: at(0.5),
    p95: at(0.95),
    worst: sorted.at(-1),
    dropped,
    droppedPct: (dropped / intervals.length) * 100,
  });

  await ctx.close();
}

await browser.close();
server.close();

const f = (n) => n.toFixed(1).padStart(6);
console.log("\nframe intervals in ms while scrolling the full page, 390x844\n");
console.log("mode              frames  median     p95   worst   dropped");
for (const r of rows) {
  console.log(
    `${r.label.padEnd(16)}${String(r.frames).padStart(6)}  ${f(r.median)}  ${f(r.p95)}  ${f(r.worst)}` +
      `   ${r.dropped} (${r.droppedPct.toFixed(1)}%)`,
  );
}

const throttled = rows.find((r) => r.label.startsWith("4x"));
console.log(
  `\n4x throttle: ${throttled.dropped} dropped of ${throttled.frames} frames ` +
    `(${throttled.droppedPct.toFixed(1)}%), p95 ${throttled.p95.toFixed(1)}ms\n`,
);
