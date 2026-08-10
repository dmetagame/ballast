#!/usr/bin/env node
// Browser verification for the landing page.
//
//   npm run build && npm run verify
//
// Checks behaviour rather than source. The claims this asserts are the ones that protect the
// page's credibility: with reduced motion, or before any scroll, every measured figure and
// every caveat must already be on screen. A reveal animation that hides a risk disclosure
// until the reader scrolls has damaged the thing it was hired to sell.

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = fileURLToPath(new URL(".", import.meta.url));
const dist = join(here, "dist");
if (!existsSync(join(dist, "index.html"))) throw new Error("run `npm run build` first");

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

const server = createServer((req, res) => {
  const path = req.url.split("?")[0];
  const file = join(dist, path === "/" ? "index.html" : path);
  if (!file.startsWith(dist) || !existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// Text that must be legible no matter what. Figures are the argument; caveats qualify it.
const MUST_BE_VISIBLE = [
  ["figure: positions", "739"],
  ["figure: debt", "$27.1M"],
  ["figure: near band", "148"],
  ["figure: penalties at -20%", "$182,701"],
  ["caveat: not audited", "not audited"],
  ["caveat: owner powers", "change the swap adapter"],
  ["caveat: liquidity ceiling", "300,000 FXRP"],
  ["caveat: no guarantee", "not a guarantee against liquidation"],
];

async function visibleText(page) {
  return page.evaluate(() => {
    // innerText reflects what is actually rendered, so display:none and visibility:hidden
    // subtrees drop out. Opacity does not, so check that separately where it matters.
    return document.body.innerText;
  });
}

const browser = await chromium.launch();

// --- reduced motion -------------------------------------------------------------------
{
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: "networkidle" });

  const htmlClass = await page.evaluate(() => document.documentElement.className);
  check("reduced: Lenis never constructed", !/lenis/i.test(htmlClass), `html class="${htmlClass}"`);

  const text = await visibleText(page);
  for (const [name, needle] of MUST_BE_VISIBLE) {
    check(`reduced: ${name}`, text.includes(needle));
  }

  // The mechanism steps are dimmed to 0.35 only when motion runs. Under reduced motion the
  // context never executes, so they must be fully opaque.
  const dimmed = await page.evaluate(() =>
    [...document.querySelectorAll(".mechanism .steps li")].map((el) => getComputedStyle(el).opacity),
  );
  check("reduced: mechanism steps at full opacity", dimmed.every((o) => o === "1"), `opacities ${dimmed.join(",")}`);

  // Nothing may be left transformed, since no timeline should exist at all.
  const marker = await page.evaluate(() => {
    const el = document.querySelector('[data-role="health-marker"]');
    return getComputedStyle(el).transform;
  });
  check("reduced: hero marker untransformed", marker === "none" || marker === "matrix(1, 0, 0, 1, 0, 0)", marker);

  await ctx.close();
}

// --- motion enabled, first paint ------------------------------------------------------
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: "networkidle" });

  const htmlClass = await page.evaluate(() => document.documentElement.className);
  check("motion: Lenis active", /lenis/i.test(htmlClass), `html class="${htmlClass}"`);

  const text = await visibleText(page);
  for (const [name, needle] of MUST_BE_VISIBLE) {
    check(`first paint: ${name}`, text.includes(needle));
  }

  await ctx.close();
}

// --- loaded already scrolled past the reveal ------------------------------------------
// The drawdown rows use gsap.from with once:true. If that trigger fails to fire when the
// page loads past its start, JS would be leaving measured numbers invisible. Deep-link to
// the footer so the reveal's start is already behind us on first evaluation.
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${base}/#limits`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);

  const rows = await page.evaluate(() =>
    [...document.querySelectorAll(".drawdown tbody tr")].map((el) => getComputedStyle(el).opacity),
  );
  check("deep link: drawdown rows visible", rows.every((o) => Number(o) > 0.9), `opacities ${rows.join(",")}`);
}

await browser.close();
server.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
