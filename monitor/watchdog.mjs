#!/usr/bin/env node

const DEFAULT_HEALTH_URL = "https://ballast.rouma.online/ops/health.json";
const DEFAULT_RELEASE_URLS = [
  "https://ballast.rouma.online/product/release.json",
  "https://ballast.rouma.online/risk/release.json",
  "https://ballast.rouma.online/enroll/release.json",
];

function positiveInteger(name, fallback, env = process.env) {
  const value = Number(env[name] || fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function validatePublicHealth(payload, {
  nowMs = Date.now(),
  maxAgeMs = 12 * 60_000,
  expectedCommit,
} = {}) {
  if (payload?.version !== 1 || payload.service !== "ballast") throw new Error("public health identity is invalid");
  if (!["ok", "failed"].includes(payload.status)) throw new Error("public health status is invalid");
  if (payload.status !== "ok") throw new Error(`public health reports ${payload.status}`);
  if (!/^[0-9a-f]{40}$/i.test(payload.releaseCommit || "")) throw new Error("public health release commit is invalid");
  if (expectedCommit && payload.releaseCommit.toLowerCase() !== expectedCommit.toLowerCase()) {
    throw new Error(`public health release mismatch: ${payload.releaseCommit} != ${expectedCommit}`);
  }
  const checkedMs = Date.parse(payload.checkedAt);
  if (!Number.isFinite(checkedMs)) throw new Error("public health timestamp is invalid");
  const ageMs = nowMs - checkedMs;
  if (ageMs < 0 || ageMs > maxAgeMs) throw new Error(`public health is stale: ${Math.round(ageMs / 1000)}s old`);
  return { status: payload.status, releaseCommit: payload.releaseCommit, checkedAt: payload.checkedAt, ageMs };
}

async function fetchJson(url, fetchImpl = fetch) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, { cache: "no-store", headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`${url} returned ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw lastError;
}

export async function runWatchdog({
  healthUrl = process.env.HEALTH_URL || DEFAULT_HEALTH_URL,
  releaseUrls = process.env.RELEASE_URLS
    ? process.env.RELEASE_URLS.split(",").map((value) => value.trim()).filter(Boolean)
    : DEFAULT_RELEASE_URLS,
  maxAgeMs = positiveInteger("MAX_HEALTH_AGE_SECONDS", 12 * 60) * 1_000,
  expectedCommit = process.env.EXPECTED_RELEASE_COMMIT?.trim(),
  nowMs = Date.now(),
  fetchImpl = fetch,
} = {}) {
  if (!releaseUrls.length) throw new Error("at least one release URL is required");
  const [health, ...releases] = await Promise.all([
    fetchJson(healthUrl, fetchImpl),
    ...releaseUrls.map((url) => fetchJson(url, fetchImpl)),
  ]);
  const commits = releases.map((release, index) => {
    if (!/^[0-9a-f]{40}$/i.test(release?.commit || "")) throw new Error(`release commit is invalid: ${releaseUrls[index]}`);
    return release.commit.toLowerCase();
  });
  if (!commits.every((commit) => commit === commits[0])) throw new Error(`static release mismatch: ${commits.join(", ")}`);
  if (expectedCommit && commits[0] !== expectedCommit.toLowerCase()) {
    throw new Error(`deployed release mismatch: ${commits[0]} != ${expectedCommit}`);
  }
  const state = validatePublicHealth(health, { nowMs, maxAgeMs, expectedCommit: commits[0] });
  return { ...state, healthUrl, releaseUrls };
}

async function main() {
  const result = await runWatchdog();
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), service: "ballast-watchdog", ...result }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), service: "ballast-watchdog", status: "failed", error: error.message }));
    process.exitCode = 1;
  });
}
