import test from "node:test";
import assert from "node:assert/strict";
import { runWatchdog, validatePublicHealth } from "./watchdog.mjs";

const COMMIT = "bd1f7d682dc50a538187e87f9775b001e7610715";
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
    expectedCommit: "0".repeat(40),
    nowMs: NOW,
    fetchImpl,
  }), /deployed release mismatch/);

  responses.set("https://two", { commit: "0".repeat(40) });
  await assert.rejects(runWatchdog({ healthUrl: "https://health", releaseUrls: ["https://one", "https://two"], nowMs: NOW, fetchImpl }), /static release mismatch/);
});
