#!/usr/bin/env node
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { decodeFunctionData, encodeFunctionResult, getAddress, parseAbi, toFunctionSelector } from "viem";

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

const ACCOUNT = getAddress("0xEE3eA6f858aE84dD6959f241DfC257a2f8fA3f53");
const SECOND_ACCOUNT = getAddress("0x1111111111111111111111111111111111111111");
const MANAGER = getAddress("0x746066ACe5dc89a3692137b8cdE3c31328629d09");
const MORPHO = getAddress("0xF4346F5132e810f80a28487a79c7559d9797E8B0");
const KEEPER = getAddress("0xA20a59090f609329405F5DcA785Af9357F6965E7");
const MARKET_ID = "0x2f31ab3fc12d6d10d1de9e5c74053126f03ac1f80a2e6d69d36a411fef7d942f";
const HASHES = {
  authorize: `0x${"11".repeat(32)}`,
  policy: `0x${"22".repeat(32)}`,
  disable: `0x${"33".repeat(32)}`,
  revoke: `0x${"44".repeat(32)}`,
};
const morphoAbi = parseAbi([
  "function isAuthorized(address authorizer, address authorized) view returns (bool)",
  "function setAuthorization(address authorized, bool newIsAuthorized)",
]);
const managerAbi = parseAbi([
  "function policyOf(address borrower, bytes32 id) view returns ((uint128 triggerHealth, uint128 targetHealth, uint64 maxCollateralPerAction, uint32 maxSlippageBps, uint32 keeperFeeBps, uint32 cooldown, uint64 lastAction, bool enabled, address keeper))",
  "function previewProtect(address borrower, bytes32 id) view returns (bool actionable, uint256 health, uint256 repayAssets, uint256 collateralNeeded)",
  "function setPolicy(bytes32 id, uint128 triggerHealth, uint128 targetHealth, uint64 maxCollateralPerAction, uint32 maxSlippageBps, uint32 keeperFeeBps, uint32 cooldown, address keeper)",
  "function disablePolicy(bytes32 id)",
]);
const selectors = {
  isAuthorized: toFunctionSelector("isAuthorized(address,address)"),
  setAuthorization: toFunctionSelector("setAuthorization(address,bool)"),
  policyOf: toFunctionSelector("policyOf(address,bytes32)"),
  previewProtect: toFunctionSelector("previewProtect(address,bytes32)"),
  setPolicy: toFunctionSelector("setPolicy(bytes32,uint128,uint128,uint64,uint32,uint32,uint32,address)"),
  disablePolicy: toFunctionSelector("disablePolicy(bytes32)"),
};

function receipt(hash, status) {
  return {
    blockHash: `0x${"55".repeat(32)}`,
    blockNumber: "0x100",
    contractAddress: null,
    cumulativeGasUsed: "0x5208",
    effectiveGasPrice: "0x1",
    from: ACCOUNT,
    gasUsed: "0x5208",
    logs: [],
    logsBloom: `0x${"00".repeat(256)}`,
    status,
    to: MORPHO,
    transactionHash: hash,
    transactionIndex: "0x0",
    type: "0x2",
  };
}

function policyResult(policy) {
  return {
    triggerHealth: policy?.triggerHealth || 0n,
    targetHealth: policy?.targetHealth || 0n,
    maxCollateralPerAction: policy?.maxCollateralPerAction || 0n,
    maxSlippageBps: policy?.maxSlippageBps || 0,
    keeperFeeBps: policy?.keeperFeeBps || 0,
    cooldown: policy?.cooldown || 0,
    lastAction: 0n,
    enabled: policy?.enabled || false,
    keeper: policy?.keeper || "0x0000000000000000000000000000000000000000",
  };
}

async function walletPage(browser, { initialChainId = 14, revertedHash = null, receiptDelayMs = 0, viewport = { width: 1280, height: 900 } } = {}) {
  const state = { authorizedAccounts: new Set(), policies: new Map(), appliedReceipts: new Set() };
  const accountKey = (value) => getAddress(value).toLowerCase();
  const page = await browser.newPage({ viewport });
  await page.addInitScript(({ account, hashes, initialChainId, selectors }) => {
    let chainId = initialChainId;
    let currentAccount = account;
    const requests = [];
    const listeners = new Map();
    window.__walletMock = {
      requests,
      emit(event, payload) {
        if (event === "accountsChanged" && payload.length) currentAccount = payload[0];
        for (const listener of listeners.get(event) || []) listener(payload);
      },
    };
    window.ethereum = {
      async request({ method, params = [] }) {
        requests.push({ method, params });
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [currentAccount];
        if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
        if (method === "wallet_switchEthereumChain") {
          chainId = Number.parseInt(params[0].chainId, 16);
          return null;
        }
        if (method === "wallet_addEthereumChain") return null;
        if (method === "eth_sendTransaction") {
          const data = params[0].data.toLowerCase();
          const selector = data.slice(0, 10);
          if (selector === selectors.setPolicy) return hashes.policy;
          if (selector === selectors.disablePolicy) return hashes.disable;
          if (selector === selectors.setAuthorization) return data.endsWith("1") ? hashes.authorize : hashes.revoke;
        }
        throw new Error(`unexpected wallet RPC method: ${method}`);
      },
      on(event, listener) {
        const handlers = listeners.get(event) || [];
        handlers.push(listener);
        listeners.set(event, handlers);
      },
    };
  }, { account: ACCOUNT, hashes: HASHES, initialChainId, selectors });
  await page.route("https://flare-api.flare.network/**", async (route) => {
    const request = route.request().postDataJSON();
    let result;
    if (request.method === "eth_call") {
      const call = request.params[0];
      const selector = call.data.slice(0, 10).toLowerCase();
      if (selector === selectors.isAuthorized) {
        const { args: [authorizer] } = decodeFunctionData({ abi: morphoAbi, data: call.data });
        result = encodeFunctionResult({ abi: morphoAbi, functionName: "isAuthorized", result: state.authorizedAccounts.has(accountKey(authorizer)) });
      } else if (selector === selectors.policyOf) {
        const { args: [borrower] } = decodeFunctionData({ abi: managerAbi, data: call.data });
        result = encodeFunctionResult({ abi: managerAbi, functionName: "policyOf", result: policyResult(state.policies.get(accountKey(borrower))) });
      } else if (selector === selectors.previewProtect) {
        result = encodeFunctionResult({ abi: managerAbi, functionName: "previewProtect", result: [false, 135n * 10n ** 16n, 0n, 0n] });
      } else {
        throw new Error(`unexpected eth_call selector: ${selector}`);
      }
    } else if (request.method === "eth_getTransactionReceipt") {
      if (receiptDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, receiptDelayMs));
      const hash = request.params[0].toLowerCase();
      const status = revertedHash?.toLowerCase() === hash ? "0x0" : "0x1";
      if (status === "0x1" && !state.appliedReceipts.has(hash)) {
        state.appliedReceipts.add(hash);
        const borrower = accountKey(ACCOUNT);
        if (hash === HASHES.authorize.toLowerCase()) state.authorizedAccounts.add(borrower);
        if (hash === HASHES.policy.toLowerCase()) state.policies.set(borrower, {
          triggerHealth: 115n * 10n ** 16n,
          targetHealth: 130n * 10n ** 16n,
          maxCollateralPerAction: 100n * 10n ** 6n,
          maxSlippageBps: 100,
          keeperFeeBps: 25,
          cooldown: 3600,
          enabled: true,
          keeper: KEEPER,
        });
        if (hash === HASHES.disable.toLowerCase()) {
          const policy = state.policies.get(borrower);
          if (policy) policy.enabled = false;
        }
        if (hash === HASHES.revoke.toLowerCase()) state.authorizedAccounts.delete(borrower);
      }
      result = receipt(hash, status);
    } else {
      throw new Error(`unexpected public RPC method: ${request.method}`);
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
    });
  });
  await navigate(page, base);
  return { page, state };
}

const browser = await chromium.launch();
for (const [name, viewport] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }], ["narrow", { width: 320, height: 700 }]]) {
  const page = await browser.newPage({ viewport });
  await navigate(page, base);
  check(`${name}: no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth === innerWidth));
  check(`${name}: controlled beta is visible`, await page.locator(".notice-amber").isVisible());
  check(`${name}: dry-run warning is explicit`, (await page.locator(".notice-amber").innerText()).includes("Do not rely on Ballast"));
  check(`${name}: conservative defaults are rendered`, await page.locator('#triggerHealth[value="1.15"]').isVisible() && await page.locator('#maxCollateral[value="100"]').isVisible());
  check(`${name}: transaction controls start disabled`, await page.locator("#authorizeButton").isDisabled() && await page.locator("#policyButton").isDisabled());
  check(`${name}: atomic custody wording is visible`, (await page.locator(".flow-card .body-copy").innerText()).includes("one atomic transaction"));
  check(`${name}: product, risk, and enrollment navigation is present`, await page.locator('.surface-nav a[href="https://ballast.rouma.online/product/"]').isVisible() && await page.locator('.surface-nav a[href="https://ballast.rouma.online/risk/"]').isVisible() && await page.locator('.surface-nav a[aria-current="page"]').isVisible());
  await page.locator("#connectButton").click();
  check(`${name}: missing wallet is handled`, (await page.locator("#statusMessage").innerText()).includes("Install a wallet"));
  await page.close();
}

const writesEnabled = await (async () => {
  const page = await browser.newPage();
  await navigate(page, base);
  const enabled = await page.locator('meta[name="ballast-writes-enabled"]').getAttribute("content");
  await page.close();
  return enabled === "true";
})();
check("wallet flow: production writes build is enabled", writesEnabled);
if (writesEnabled) {
  const connectedMobile = await walletPage(browser, { viewport: { width: 390, height: 844 } });
  await connectedMobile.page.locator("#connectButton").click();
  check("wallet flow: connected mobile has no horizontal overflow", await connectedMobile.page.evaluate(() => document.documentElement.scrollWidth === innerWidth));
  await connectedMobile.page.close();

  const connectedNarrow = await walletPage(browser, { viewport: { width: 320, height: 700 } });
  await connectedNarrow.page.locator("#connectButton").click();
  check("wallet flow: connected narrow view has no horizontal overflow", await connectedNarrow.page.evaluate(() => document.documentElement.scrollWidth === innerWidth));
  await connectedNarrow.page.close();

  const delayed = await walletPage(browser, { receiptDelayMs: 250 });
  await delayed.page.locator("#connectButton").click();
  await delayed.page.evaluate(() => {
    const button = document.getElementById("authorizeButton");
    button.click();
    button.click();
  });
  await delayed.page.locator("#authorizeButton").waitFor({ state: "visible" });
  check("wallet flow: transaction controls lock while a receipt is pending", await delayed.page.locator("#authorizeButton").isDisabled() && await delayed.page.locator("#connectButton").isDisabled() && await delayed.page.locator(".shell").getAttribute("aria-busy") === "true");
  await delayed.page.locator("#statusMessage").filter({ hasText: "Morpho authorization confirmed." }).waitFor();
  const delayedWrites = await delayed.page.evaluate(() => window.__walletMock.requests.filter(({ method }) => method === "eth_sendTransaction"));
  check("wallet flow: duplicate authorization clicks send one transaction", delayedWrites.length === 1);
  check("wallet flow: controls unlock after confirmation", await delayed.page.locator("#connectButton").isEnabled() && await delayed.page.locator(".shell").getAttribute("aria-busy") === "false");
  await delayed.page.close();

  const pendingSwitch = await walletPage(browser, { receiptDelayMs: 250 });
  await pendingSwitch.page.locator("#connectButton").click();
  await pendingSwitch.page.locator("#authorizeButton").click();
  await pendingSwitch.page.locator("#statusMessage").filter({ hasText: "Authorization submitted" }).waitFor();
  await pendingSwitch.page.evaluate((nextAccount) => window.__walletMock.emit("accountsChanged", [nextAccount]), SECOND_ACCOUNT);
  await pendingSwitch.page.locator("#statusMessage").filter({ hasText: "connected wallet changed" }).waitFor();
  check("wallet flow: account changes during a transaction are reported", (await pendingSwitch.page.locator("#walletAddress").innerText()) === SECOND_ACCOUNT && (await pendingSwitch.page.locator("#authorizationStatus").innerText()) === "Not authorized");
  check("wallet flow: changed-account transaction controls unlock", await pendingSwitch.page.locator("#authorizeButton").isEnabled() && await pendingSwitch.page.locator(".shell").getAttribute("aria-busy") === "false");
  await pendingSwitch.page.close();

  const accountSwitch = await walletPage(browser);
  await accountSwitch.page.locator("#connectButton").click();
  await accountSwitch.page.locator("#authorizeButton").click();
  await accountSwitch.page.locator("#statusMessage").filter({ hasText: "Morpho authorization confirmed." }).waitFor();
  await accountSwitch.page.locator("#triggerHealth").fill("1.05");
  const switchedState = await accountSwitch.page.evaluate((nextAccount) => {
    window.__walletMock.emit("accountsChanged", [nextAccount]);
    return {
      authorizeDisabled: document.getElementById("authorizeButton").disabled,
      policyDisabled: document.getElementById("policyButton").disabled,
      wallet: document.getElementById("walletAddress").textContent,
      authorization: document.getElementById("authorizationStatus").textContent,
      health: document.getElementById("healthStatus").textContent,
      policy: document.getElementById("policyStatus").textContent,
      preview: document.getElementById("previewStatus").textContent,
      summary: document.getElementById("policySummary").textContent,
    };
  }, SECOND_ACCOUNT);
  check(
    "wallet flow: account changes clear stale account data",
    switchedState.authorizeDisabled
      && switchedState.policyDisabled
      && switchedState.wallet === SECOND_ACCOUNT
      && [switchedState.authorization, switchedState.health, switchedState.policy, switchedState.preview].every((value) => value === "Refreshing...")
      && switchedState.summary.includes("1.15×")
      && !switchedState.summary.includes("1.05×"),
  );
  await accountSwitch.page.close();

  const { page } = await walletPage(browser, { initialChainId: 1 });
  page.on("dialog", (dialog) => dialog.accept());
  await page.locator("#connectButton").click();
  check("wallet flow: wrong chain is detected", (await page.locator("#chainStatus").innerText()).includes("Wrong network"));
  await page.locator("#authorizeButton").click();
  await page.locator("#statusMessage").filter({ hasText: "Morpho authorization confirmed." }).waitFor();
  check("wallet flow: chain switch succeeds", (await page.locator("#chainStatus").innerText()).includes("chain 14"));
  check("wallet flow: authorization receipt enables policy", await page.locator("#policyButton").isEnabled());

  await page.locator("#policyButton").click();
  await page.locator("#statusMessage").filter({ hasText: "Protection policy confirmed onchain." }).waitFor();
  check("wallet flow: policy receipt renders enabled state", (await page.locator("#policyStatus").innerText()).includes("Enabled"));

  check("wallet flow: revoke stays disabled while policy is active", await page.locator("#revokeAuthorizationButton").isDisabled());
  await page.locator("#disablePolicyButton").click();
  await page.locator("#statusMessage").filter({ hasText: "You can now revoke" }).waitFor();
  check("wallet flow: policy disable unlocks revocation", await page.locator("#revokeAuthorizationButton").isEnabled());
  await page.locator("#revokeAuthorizationButton").click();
  await page.locator("#statusMessage").filter({ hasText: "Morpho authorization revoked." }).waitFor();

  const walletRequests = await page.evaluate(() => window.__walletMock.requests);
  const switchRequest = walletRequests.find(({ method }) => method === "wallet_switchEthereumChain");
  check("wallet flow: requests Flare chain 14", switchRequest?.params?.[0]?.chainId === "0xe");
  const writes = walletRequests.filter(({ method }) => method === "eth_sendTransaction").map(({ params }) => params[0]);
  const decoded = writes.map((write) => {
    const abi = write.to.toLowerCase() === MORPHO.toLowerCase() ? morphoAbi : managerAbi;
    return decodeFunctionData({ abi, data: write.data });
  });
  check("wallet flow: transaction order is authorize, policy, disable, revoke", decoded.map(({ functionName }) => functionName).join(",") === "setAuthorization,setPolicy,disablePolicy,setAuthorization");
  check("wallet flow: authorization targets V3 manager", decoded[0].args[0] === MANAGER && decoded[0].args[1] === true);
  check("wallet flow: policy write uses conservative defaults", decoded[1].args[0] === MARKET_ID && decoded[1].args[1] === 115n * 10n ** 16n && decoded[1].args[2] === 130n * 10n ** 16n && decoded[1].args[3] === 100n * 10n ** 6n && decoded[1].args[4] === 100 && decoded[1].args[5] === 25 && decoded[1].args[6] === 3600 && decoded[1].args[7] === KEEPER);
  check("wallet flow: exit disables policy before revoking authorization", decoded[2].args[0] === MARKET_ID && decoded[3].args[0] === MANAGER && decoded[3].args[1] === false);
  await page.close();

  const reverted = await walletPage(browser, { revertedHash: HASHES.authorize });
  await reverted.page.locator("#connectButton").click();
  await reverted.page.locator("#authorizeButton").click();
  await reverted.page.locator("#statusMessage").filter({ hasText: "reverted onchain" }).waitFor();
  check("wallet flow: reverted receipt is surfaced", (await reverted.page.locator("#statusMessage").innerText()).includes("Morpho authorization reverted onchain"));
  check("wallet flow: reverted authorization does not enable policy", await reverted.page.locator("#policyButton").isDisabled());
  await reverted.page.close();
}
await browser.close();
if (!remote) server.close();

const failed = checks.filter((result) => !result.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exitCode = 1;
