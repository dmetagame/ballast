import { readFileSync } from "node:fs";

const baseUrl = process.env.BASE_URL?.replace(/\/$/, "");
const response = baseUrl ? await fetch(baseUrl, { redirect: "follow" }) : null;
if (response && !response.ok) throw new Error(`deployment returned ${response.status} ${response.statusText}`);
const html = response ? await response.text() : readFileSync(new URL("./index.html", import.meta.url), "utf8");

const checks = [
  ["HTML doctype", /^<!doctype html>/i.test(html)],
  ["document language", /<html\s+lang=["']en["']/i.test(html)],
  ["mobile viewport", /<meta\s+name=["']viewport["']\s+content=["']width=device-width, initial-scale=1\.0["']/i.test(html)],
  ["risk snapshot", html.includes("const DATA =") && /"positions":\d+/.test(html)],
  ["production manager", html.toLowerCase().includes("0x746066ace5dc89a3692137b8cde3c31328629d09")],
  ["controlled address disclosure", html.includes("Borrower addresses are truncated")],
  ["drawdown metric is named precisely", html.includes("Liquidated by XRP −25%")],
  ["mobile table containment", html.includes("overflow: hidden; min-width: 0")],
  ["long provenance wraps", html.includes("overflow-wrap: anywhere")],
  ["product navigation", html.includes('href="https://ballast.rouma.online/product/"')],
  ["risk navigation", html.includes('href="https://ballast.rouma.online/risk/" aria-current="page"')],
  ["enrollment navigation", html.includes('href="https://ballast.rouma.online/enroll/"')],
];

const payload = html.match(/const DATA = (\{.*?\});/s)?.[1];
if (!payload) throw new Error("dashboard payload is missing");
const { meta, rows } = JSON.parse(payload);
if (!Number.isInteger(meta.healthBandPositions) || !Number.isInteger(meta.healthBandDebt)) {
  throw new Error("dashboard health-band provenance is missing");
}
if (!Number.isSafeInteger(meta.block) || !/^0x[0-9a-f]{64}$/i.test(meta.blockHash || "") || !Number.isFinite(meta.xrpUsd)) {
  throw new Error("dashboard pinned snapshot provenance is missing");
}
if (!Array.isArray(rows) || rows.some((row) => row[4] < 1)) {
  throw new Error("dashboard includes a position with debt below the published $1 floor");
}
if (rows.some((row) => !Number.isFinite(row[7]) || !Number.isFinite(row[8]))) {
  throw new Error("dashboard liquidation parameters are incomplete");
}

const failed = checks.filter(([, pass]) => !pass);
for (const [name, pass] of checks) console.log(`${pass ? "ok" : "FAIL"} ${name}`);
if (failed.length) process.exit(1);
if (baseUrl) console.log(`deployment verified: ${baseUrl}`);
