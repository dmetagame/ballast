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
];

const failed = checks.filter(([, pass]) => !pass);
for (const [name, pass] of checks) console.log(`${pass ? "ok" : "FAIL"} ${name}`);
if (failed.length) process.exit(1);
if (baseUrl) console.log(`deployment verified: ${baseUrl}`);
