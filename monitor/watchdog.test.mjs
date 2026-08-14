import test from "node:test";
import assert from "node:assert/strict";
import { runWatchdog, validatePublicHealth } from "./watchdog.mjs";

const COMMIT = "bd1f7d682dc50a538187e87f9775b001e7610715";
const NEXT_COMMIT = "d2ded434f5d6ea647a3c74a1e48c9bb05d44b2a5";
const OTHER_COMMIT = "0".repeat(40);
const NOW = Date.parse("2026-08-14T06:00:00Z");

test("public health accepts a fresh matching successful check", () => {
  assert.deepEqual(validatePublicHealth({
    version: 1,
    service: "ballast",
    status: "ok",
    checkedAt: "2026-08-14T05:55:00Z",
    releaseCommit: COMMIT,
  }, { nowMs: NOW, maxAgeMs: 600_000, expectedCommit: COMMIT }), {
    status: "ok",
    checkedAt: "2026-08-14T05:55:00Z",
    releaseCommit: COMMIT,
    ageMs: 300_000,
  });
});

test("public health rejects failures, stale checks, and release mismatches", () => {
  const state = {
    version: 1,
    service: "ballast",
    status: "ok",
    checkedAt: "2026-08-14T05:55:00Z",
    releaseCommit: COMMIT,
  };
  assert.throws(() => validatePublicHealth({ ...state, status: "failed" }, { nowMs: NOW }), /reports failed/);
  assert.throws(() => validatePublicHealth({ ...state, checkedAt: "2026-08-14T05:00:00Z" }, { nowMs: NOW, maxAgeMs: 600_000 }), /stale/);
  assert.throws(() => validatePublicHealth(state, { nowMs: NOW, expectedCommit: "0".repeat(40) }), /release mismatch/);
});

test("watchdog requires all public release commits to match health", async () => {
  const responses = new Map([
    ["https://health", { version: 1, service: "ballast", status: "ok", checkedAt: "2026-08-14T05:55:00Z", releaseCommit: COMMIT }],
    ["https://one", { commit: COMMIT }],
    ["https://two", { commit: COMMIT }],
  ]);
  const fetchImpl = async (url) => ({ ok: true, json: async () => responses.get(url) });
  const result = await runWatchdog({ healthUrl: "https://health", releaseUrls: ["https://one", "https://two"], nowMs: NOW, fetchImpl });
  assert.equal(result.releaseCommit, COMMIT);

  await assert.rejects(runWatchdog({
    healthUrl: "https://health",
    releaseUrls: ["https://one", "https://two"],
    expectedCommit: OTHER_COMMIT,
    nowMs: NOW,
    fetchImpl,
  }), /deployed release mismatch/);

  responses.set("https://two", { commit: OTHER_COMMIT });
  await assert.rejects(runWatchdog({ healthUrl: "https://health", releaseUrls: ["https://one", "https://two"], nowMs: NOW, fetchImpl }), /static release mismatch/);
});

test("watchdog accepts only the current and previous commit during a bounded rollout", async () => {
  const responses = new Map([
    ["https://health", { version: 1, service: "ballast", status: "ok", checkedAt: "2026-08-14T05:55:00Z", releaseCommit: COMMIT }],
    ["https://one", { commit: NEXT_COMMIT }],
    ["https://two", { commit: NEXT_COMMIT }],
  ]);
  const fetchImpl = async (url) => ({ ok: true, json: async () => responses.get(url) });
  const result = await runWatchdog({
    healthUrl: "https://health",
    releaseUrls: ["https://one", "https://two"],
    expectedCommit: NEXT_COMMIT,
    previousCommit: COMMIT,
    rolloutDeadlineMs: NOW + 60_000,
    nowMs: NOW,
    fetchImpl,
  });
  assert.equal(result.rolloutState, "in_progress");
  assert.equal(result.staticReleaseCommit, NEXT_COMMIT);
  assert.equal(result.releaseCommit, COMMIT);

  responses.set("https://health", { version: 1, service: "ballast", status: "ok", checkedAt: "2026-08-14T05:55:00Z", releaseCommit: NEXT_COMMIT });
  const current = await runWatchdog({
    healthUrl: "https://health",
    releaseUrls: ["https://one", "https://two"],
    expectedCommit: NEXT_COMMIT,
    previousCommit: COMMIT,
    rolloutDeadlineMs: NOW + 60_000,
    nowMs: NOW,
    fetchImpl,
  });
  assert.equal(current.rolloutState, "current");
});

test("watchdog rejects an expired or unrelated rollout release", async () => {
  const responses = new Map([
    ["https://health", { version: 1, service: "ballast", status: "ok", checkedAt: "2026-08-14T05:55:00Z", releaseCommit: COMMIT }],
    ["https://one", { commit: COMMIT }],
    ["https://two", { commit: COMMIT }],
  ]);
  const fetchImpl = async (url) => ({ ok: true, json: async () => responses.get(url) });
  await assert.rejects(runWatchdog({
    healthUrl: "https://health",
    releaseUrls: ["https://one", "https://two"],
    expectedCommit: NEXT_COMMIT,
    previousCommit: COMMIT,
    rolloutDeadlineMs: NOW - 1,
    nowMs: NOW,
    fetchImpl,
  }), /deployed release mismatch/);

  responses.set("https://health", { version: 1, service: "ballast", status: "ok", checkedAt: "2026-08-14T05:55:00Z", releaseCommit: OTHER_COMMIT });
  responses.set("https://one", { commit: OTHER_COMMIT });
  responses.set("https://two", { commit: OTHER_COMMIT });
  await assert.rejects(runWatchdog({
    healthUrl: "https://health",
    releaseUrls: ["https://one", "https://two"],
    expectedCommit: NEXT_COMMIT,
    previousCommit: COMMIT,
    rolloutDeadlineMs: NOW + 60_000,
    nowMs: NOW,
    fetchImpl,
  }), /deployed release mismatch/);
});

test("watchdog rejects incomplete rollout configuration before fetching production", async () => {
  const fetchImpl = async () => {
    throw new Error("fetch should not run");
  };
  await assert.rejects(runWatchdog({
    healthUrl: "https://health",
    releaseUrls: ["https://one"],
    expectedCommit: NEXT_COMMIT,
    previousCommit: COMMIT,
    nowMs: NOW,
    fetchImpl,
  }), /release rollout configuration is incomplete/);
  await assert.rejects(runWatchdog({
    healthUrl: "https://health",
    releaseUrls: ["https://one"],
    expectedCommit: NEXT_COMMIT,
    rolloutDeadlineMs: NOW + 60_000,
    nowMs: NOW,
    fetchImpl,
  }), /release rollout configuration is incomplete/);
  await assert.rejects(runWatchdog({
    healthUrl: "https://health",
    releaseUrls: ["https://one"],
    previousCommit: COMMIT,
    rolloutDeadlineMs: NOW + 60_000,
    nowMs: NOW,
    fetchImpl,
  }), /release rollout configuration is incomplete/);
});
