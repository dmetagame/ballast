import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./snapshot.mjs";

const read = (name) => JSON.parse(readFileSync(join(DATA_DIR, name), "utf8"));
const isFullAddress = (value) => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);

test("published borrower datasets are redacted and internally complete", () => {
  const enosys = read("positions.json");
  const morpho = read("morpho-positions.json");
  assert.ok(enosys.length > 0);
  assert.ok(morpho.length > 0);
  assert.ok([...enosys, ...morpho].every((position) => !isFullAddress(position.acct)));

  for (const position of enosys) {
    assert.ok(position.debtUSD >= 1);
    assert.ok(position.health > 0);
    assert.ok(position.closeFactor > 0 && position.closeFactor <= 1);
    assert.ok(position.liquidationPenalty >= 0);
    assert.ok(Array.isArray(position.legs));
    assert.ok(position.legs.every((leg) => typeof leg.collateralEnabled === "boolean"));
    if (position.dropToLiq !== null) {
      assert.ok(position.collXrpUSD > position.debtXrpUSD);
      assert.ok(position.collStableUSD <= position.debtStableUSD + 0.01);
      assert.ok(position.dropToLiq <= 100);
    }
  }

  for (const position of morpho) {
    assert.ok(position.health > 0);
    assert.equal(position.closeFactor, 1);
    assert.ok(position.liquidationPenalty >= 0 && position.liquidationPenalty <= 0.15);
  }
});

test("published Morpho market metadata is pinned and usable", () => {
  const markets = read("morpho-markets.json");
  assert.ok(markets.length > 0);
  for (const market of markets) {
    assert.match(market.id, /^0x[0-9a-f]{64}$/i);
    assert.match(market.loanToken, /^0x[0-9a-f]{40}$/i);
    assert.match(market.collateralToken, /^0x[0-9a-f]{40}$/i);
    assert.ok(market.loanSym && market.collSym);
    assert.ok(Number.isSafeInteger(market.loanDec) && Number.isSafeInteger(market.collDec));
    assert.ok(BigInt(market.price) > 0n);
  }
});
