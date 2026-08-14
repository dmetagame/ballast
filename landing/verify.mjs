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

// BASE_URL targets a deployed build instead of the local one, so the same checks can be run
// against production. Without it, the local dist is served over loopback.
const REMOTE = process.env.BASE_URL?.replace(/\/$/, "");
if (!REMOTE && !existsSync(join(dist, "index.html"))) throw new Error("run `npm run build` first");

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

const server = createServer((req, res) => {
  const path = req.url.split("?")[0];
  const file = join(dist, path === "/" ? "index.html" : path);
  if (!file.startsWith(dist) || !existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
let base = REMOTE;
if (!REMOTE) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
} else {
  server.close();
}
console.log(`target: ${base}\n`);

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function navigate(page, url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await page.goto(url, { waitUntil: "networkidle" });
    } catch (error) {
      lastError = error;
      if (!REMOTE || attempt === 3) throw error;
      await page.waitForTimeout(attempt * 1_000);
    }
  }
  throw lastError;
}

async function fetchText(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`fetch failed: ${response.status} ${response.statusText}`);
      return response.text();
    } catch (error) {
      lastError = error;
      if (!REMOTE || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw lastError;
}

// Text that must be legible no matter what. Figures are the argument; caveats qualify it.
const MUST_BE_VISIBLE = [
  ["figure: positions", "739"],
  ["figure: debt", "$27.1M"],
  ["figure: near band", "148"],
  ["figure: penalties at -20%", "$182,701"],
  ["caveat: not audited", "not audited"],
  ["caveat: owner powers", "administrative timelock"],
  ["caveat: liquidity ceiling", "300,000 FXRP"],
  ["caveat: no guarantee", "not a guarantee against liquidation"],
  ["caveat: keeper dry-run", "hosted keeper remains dry-run"],
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
  await navigate(page, base);

  // Guards against a smooth-scroll library being reintroduced. Lenis was removed because it
  // broke back/forward restoration; if one comes back, this fails before the navigation does.
  const htmlClass = await page.evaluate(() => document.documentElement.className);
  check("reduced: no smooth-scroll wrapper", !/lenis|scroll-smoother/i.test(htmlClass), `html class="${htmlClass}"`);

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
  await navigate(page, base);

  // With no smooth-scroll library, the observable difference between motion on and off is
  // whether the gsap context ran. It dims the mechanism steps to 0.35; reduced motion leaves
  // them at 1. That is the discriminator, and it is checked from both sides.
  const dimmed = await page.evaluate(() =>
    [...document.querySelectorAll(".mechanism .steps li")].map((el) => getComputedStyle(el).opacity),
  );
  check("motion: beats initialised", dimmed.some((o) => Number(o) < 1), `opacities ${dimmed.join(",")}`);

  const htmlClass = await page.evaluate(() => document.documentElement.className);
  check("motion: still native scroll", !/lenis|scroll-smoother/i.test(htmlClass), `html class="${htmlClass}"`);

  const text = await visibleText(page);
  for (const [name, needle] of MUST_BE_VISIBLE) {
    check(`first paint: ${name}`, text.includes(needle));
  }

  const drawdownOpacity = await page.evaluate(() =>
    [...document.querySelectorAll(".drawdown tbody tr")].map((el) => getComputedStyle(el).opacity),
  );
  check("first paint: drawdown rows visible", drawdownOpacity.every((o) => Number(o) > 0.9), `opacities ${drawdownOpacity.join(",")}`);

  await ctx.close();
}

// --- loaded already scrolled past the reveal ------------------------------------------
// The drawdown rows use gsap.from with once:true. If that trigger fails to fire when the
// page loads past its start, JS would be leaving measured numbers invisible. Deep-link to
// the footer so the reveal's start is already behind us on first evaluation.
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await navigate(page, `${base}/#limits`);
  await page.waitForTimeout(600);

  const rows = await page.evaluate(() =>
    [...document.querySelectorAll(".drawdown tbody tr")].map((el) => getComputedStyle(el).opacity),
  );
  check("deep link: drawdown rows visible", rows.every((o) => Number(o) > 0.9), `opacities ${rows.join(",")}`);
}

// --- counters land on the measured value ------------------------------------------------
// A counter that eases into a rounded number and stops there has published a wrong figure.
// Expected values are read from the built HTML, not typed here, so this compares the page
// against what the build actually wrote from monitor/data.
{
  const html = REMOTE ? await fetchText(REMOTE) : readFileSync(join(dist, "index.html"), "utf8");
  const authored = [...html.matchAll(/data-count="(\d+)"[^>]*>([^<]+)</g)].map((m) => ({
    count: m[1],
    text: m[2].trim(),
  }));
  check("counters: found in the built HTML", authored.length === 3, `${authored.length} elements`);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await navigate(page, base);

  // Bring the figures into view so the counters run, then let them finish.
  await page.evaluate(() => document.getElementById("stakes").scrollIntoView());
  await page.waitForTimeout(2500);

  const rendered = await page.evaluate(() =>
    [...document.querySelectorAll("[data-count]")].map((el) => ({
      count: el.dataset.count,
      text: el.textContent.trim(),
      ariaHidden: el.getAttribute("aria-hidden"),
      screenReader: el.parentElement.querySelector(".sr-only")?.textContent.trim() ?? null,
    })),
  );

  for (const expected of authored) {
    const actual = rendered.find((r) => r.count === expected.count);
    check(
      `counter ${expected.count}: lands on the measured value`,
      actual?.text === expected.text,
      `showed "${actual?.text}", authored "${expected.text}"`,
    );
  }

  check("counters: tween is hidden from screen readers", rendered.every((r) => r.ariaHidden === "true"));
  check(
    "counters: screen-reader value intact",
    rendered.every((r) => r.screenReader && r.screenReader.length > 0),
    rendered.map((r) => r.screenReader).join(" | "),
  );

  await ctx.close();
}

// --- keyboard, anchors, history --------------------------------------------------------
// Scroll effects are the most common way to break these. The page deliberately keeps native
// scrolling, so this verifies keyboard navigation, fragment links, and history restoration.
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await navigate(page, base);

  // Browser fragment navigation can settle asynchronously. Poll until the position stops
  // changing instead of relying on a fixed delay.
  const settle = async () => {
    let previous = -1;
    for (let i = 0; i < 40; i++) {
      const y = await page.evaluate(() => window.scrollY);
      if (y === previous) return;
      previous = y;
      await page.waitForTimeout(100);
    }
  };

  // Tab through every focusable control. Each must be reachable in DOM order, and each must
  // be scrolled into view once focused. A focused control off-screen is one the keyboard
  // user has lost.
  const expected = await page.evaluate(() =>
    [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")),
  );

  const seen = [];
  let offscreen = 0;
  for (let i = 0; i < expected.length; i++) {
    await page.keyboard.press("Tab");
    await settle();
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const r = el.getBoundingClientRect();
      return { href: el.getAttribute?.("href") ?? null, top: r.top, bottom: r.bottom, vh: innerHeight };
    });
    if (!info) break;
    seen.push(info.href);
    if (info.bottom < 0 || info.top > info.vh) offscreen++;
  }

  check("keyboard: every link reachable by Tab", seen.length === expected.length, `${seen.length}/${expected.length}`);
  check("keyboard: Tab follows DOM order", seen.join("|") === expected.slice(0, seen.length).join("|"), seen.join(" "));
  check("keyboard: focused control stays in view", offscreen === 0, `${offscreen} off-screen`);

  // In-page anchor must still move the native viewport.
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle();
  await page.click('a[href="#limits"]');
  await settle();
  const afterAnchor = await page.evaluate(() => ({
    y: window.scrollY,
    limitsTop: document.getElementById("limits").getBoundingClientRect().top,
    vh: window.innerHeight,
  }));
  check("anchor: #limits scrolls the page", afterAnchor.y > 200, `scrollY ${Math.round(afterAnchor.y)}`);
  // Not "lands at the top": #limits is the last element, so the browser scrolls as far as the
  // document allows and stops short. Measured at 232px without Lenis and 245px with it, so
  // demanding zero would be asserting something no browser does. In view is the real claim.
  check(
    "anchor: target is in view",
    afterAnchor.limitsTop >= 0 && afterAnchor.limitsTop < afterAnchor.vh,
    `top ${Math.round(afterAnchor.limitsTop)} of ${afterAnchor.vh}`,
  );

  // Back should return to where the reader was, not strand them at the anchor.
  await page.goBack();
  await settle();
  const afterBack = await page.evaluate(() => window.scrollY);
  check("history: back restores the previous position", afterBack < afterAnchor.y - 100, `scrollY ${Math.round(afterBack)}`);

  await page.goForward();
  await settle();
  const afterForward = await page.evaluate(() => window.scrollY);
  check("history: forward returns to the anchor", afterForward > 200, `scrollY ${Math.round(afterForward)}`);

  await ctx.close();
}

await browser.close();
if (!REMOTE) server.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
