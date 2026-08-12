import { createPublicClient, createWalletClient, custom, formatUnits, getAddress, http, parseUnits, zeroAddress } from "viem";
import { flare, ENABLE_WRITES, KEEPER, MANAGER, MANAGER_VERSION, MARKET_ID, MORPHO, managerAbi, morphoAbi } from "./config.js";
import "./styles.css";

const publicClient = createPublicClient({ chain: flare, transport: http() });
let walletClient;
let account;
let currentChainId;
let currentHealth;
let isAuthorized = false;

const $ = (id) => document.getElementById(id);
const short = (value) => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "—";
const explorer = (hash) => `${flare.blockExplorers.default.url}/tx/${hash}`;
const managerExplorer = `${flare.blockExplorers.default.url}/address/${MANAGER}`;
const setStatus = (message, tone = "") => { $("statusMessage").textContent = message; $("statusMessage").className = tone; };
const isFlare = () => currentChainId === flare.id;

function renderAccount() {
  $("connectButton").textContent = short(account);
  $("walletBadge").textContent = short(account);
  $("walletAddress").textContent = account;
  $("refreshButton").disabled = false;
}

function resetAccount() {
  account = undefined;
  currentChainId = undefined;
  currentHealth = undefined;
  isAuthorized = false;
  $("connectButton").textContent = "Connect wallet";
  $("walletBadge").textContent = "Not connected";
  $("walletAddress").textContent = "Connect a wallet";
  $("chainStatus").textContent = "—";
  $("chainStatus").className = "";
  $("authorizationStatus").textContent = "—";
  $("authorizationStatus").className = "";
  $("healthStatus").textContent = "—";
  $("healthStatus").className = "";
  $("policyStatus").textContent = "—";
  $("policyStatus").className = "";
  $("previewStatus").textContent = "—";
  $("previewStatus").className = "";
  $("refreshButton").disabled = true;
  $("authorizeButton").disabled = true;
  $("policyButton").disabled = true;
  $("disablePolicyButton").disabled = true;
  $("revokeAuthorizationButton").disabled = true;
  setStatus("Wallet disconnected.", "warning");
}

$("managerLink").href = managerExplorer;
$("managerLink").textContent = short(MANAGER);
$("networkLabel").textContent = ENABLE_WRITES ? "Flare mainnet · V3 enrollment enabled" : "Flare mainnet · read-only build";
$("deploymentNotice").innerHTML = ENABLE_WRITES
  ? "<strong>V3 finalized on Flare mainnet.</strong> The SparkDEX pool is active, ownership has moved to the production owner, and controlled enrollment writes are enabled."
  : "<strong>V3 finalized on Flare mainnet.</strong> This build is read-only; no authorization or policy transaction can be submitted.";
$("keeperAddress").value = KEEPER;

async function connect() {
  if (!window.ethereum) { setStatus("Install a wallet such as MetaMask or Rabby to continue.", "error"); return; }
  try {
    walletClient = createWalletClient({ chain: flare, transport: custom(window.ethereum) });
    const [nextAccount] = await walletClient.requestAddresses();
    account = getAddress(nextAccount);
    currentChainId = await walletClient.getChainId();
    renderAccount();
    await refresh();
    setStatus(isFlare() ? "Wallet connected. Review every value before signing." : "Wallet connected. Switch to Flare mainnet before signing.", isFlare() ? "" : "warning");
  } catch (error) { setStatus(error.shortMessage || error.message, "error"); }
}

async function switchToFlare() {
  if (!walletClient) {
    await connect();
    return isFlare();
  }
  try {
    try { await walletClient.switchChain({ id: flare.id }); }
    catch (error) {
      if (error.code !== 4902 && error.cause?.code !== 4902) throw error;
      await walletClient.addChain({ chain: flare });
      await walletClient.switchChain({ id: flare.id });
    }
    currentChainId = flare.id;
    await refresh();
    return true;
  }
  catch (error) {
    setStatus(error.shortMessage || error.message, "error");
    return false;
  }
}

async function refresh() {
  if (!account) return;
  currentChainId = walletClient ? await walletClient.getChainId() : currentChainId;
  $("chainStatus").textContent = isFlare() ? "Flare mainnet (chain 14)" : `Wrong network (chain ${currentChainId})`;
  $("chainStatus").className = isFlare() ? "good" : "bad";
  const [authorized, policy, preview] = await Promise.all([
    publicClient.readContract({ address: MORPHO, abi: morphoAbi, functionName: "isAuthorized", args: [account, MANAGER] }),
    publicClient.readContract({ address: MANAGER, abi: managerAbi, functionName: "policyOf", args: [account, MARKET_ID] }),
    publicClient.readContract({ address: MANAGER, abi: managerAbi, functionName: "previewProtect", args: [account, MARKET_ID] }),
  ]);
  const [actionable, health, repayAssets, collateralNeeded] = preview;
  currentHealth = health;
  isAuthorized = authorized;
  const healthText = health === (2n ** 256n - 1n) ? "No debt" : `${formatUnits(health, 18)}×`;
  $("healthStatus").textContent = healthText;
  $("healthStatus").className = health < 10n ** 18n ? "bad" : health < 125n * 10n ** 16n ? "warning" : "good";
  $("authorizationStatus").textContent = authorized ? "Authorized" : "Not authorized";
  $("authorizationStatus").className = authorized ? "good" : "bad";
  $("policyStatus").textContent = policy.enabled ? `Enabled · trigger ${formatUnits(policy.triggerHealth, 18)}× · keeper ${short(policy.keeper)}` : "Not configured";
  $("policyStatus").className = policy.enabled ? "good" : "muted";
  $("previewStatus").textContent = actionable
    ? `Actionable · repay ${formatUnits(repayAssets, 6)} USD₮0 · sell ${formatUnits(collateralNeeded, 6)} FXRP`
    : policy.enabled ? "Not actionable now" : "Set a policy to preview";
  $("previewStatus").className = actionable ? "warning" : "muted";
  $("authorizeButton").disabled = !ENABLE_WRITES || authorized;
  $("policyButton").disabled = !ENABLE_WRITES || !authorized;
  $("disablePolicyButton").disabled = !ENABLE_WRITES || !policy.enabled;
  $("revokeAuthorizationButton").disabled = !ENABLE_WRITES || !authorized || policy.enabled;
  $("authorizationHint").textContent = authorized ? "Authorization is already active for this wallet." : ENABLE_WRITES ? "The next step asks Morpho to authorize the configured manager." : "Writes are disabled for the published manager.";
  $("policyHint").textContent = !ENABLE_WRITES
    ? "Policy writes are disabled in this build."
    : authorized
      ? "Policies are written directly to the finalized V3 manager. The hosted keeper remains dry-run during controlled validation."
      : "Authorize the finalized V3 manager on Morpho before saving a policy.";
  $("exitHint").textContent = !ENABLE_WRITES
    ? "Exit writes are disabled for the published manager."
    : policy.enabled
      ? "Disable the policy before revoking Morpho authorization."
      : authorized
        ? "Policy disabled. Revoking authorization is now available."
        : "Protection is disabled and Morpho authorization is revoked.";
  updateSummary();
}

function numberField(id, label, decimals = 6) {
  const raw = $(id).value.trim();
  if (!raw || !/^\d+(\.\d+)?$/.test(raw)) throw new Error(`${label} must be a positive number.`);
  try { return parseUnits(raw, decimals); } catch { throw new Error(`${label} is too large or has too many decimals.`); }
}

function validatePolicy() {
  const trigger = numberField("triggerHealth", "Trigger health", 18);
  const target = numberField("targetHealth", "Target health", 18);
  const collateral = numberField("maxCollateral", "Maximum collateral", 6);
  const slippage = numberField("maxSlippage", "Maximum slippage", 2);
  const fee = numberField("keeperFee", "Keeper fee", 2);
  const cooldownRaw = $("cooldown").value.trim();
  if (!/^\d+$/.test(cooldownRaw)) throw new Error("Cooldown must be a whole number of seconds.");
  const cooldown = BigInt(cooldownRaw);
  let keeper;
  try { keeper = getAddress($("keeperAddress").value.trim()); } catch { throw new Error("Keeper address must be a valid address."); }
  if (keeper === zeroAddress) throw new Error("Keeper address cannot be zero in production mode.");
  if (trigger < 10n ** 18n) throw new Error("Trigger health cannot be below 1.00×.");
  if (target <= trigger) throw new Error("Target health must be greater than trigger health.");
  if (collateral <= 0n) throw new Error("Maximum collateral must be greater than zero.");
  if (slippage > 1000n) throw new Error("Maximum slippage cannot exceed 10%.");
  if (fee > 500n) throw new Error("Keeper fee cannot exceed 5%.");
  if (cooldown > 4294967295n) throw new Error("Cooldown is too large for the contract.");
  if (collateral > 18446744073709551615n) throw new Error("Maximum collateral is too large for the contract.");
  return [MARKET_ID, trigger, target, collateral, slippage, fee, cooldown, keeper];
}

function updateSummary() {
  try {
    const [, trigger, target, collateral, slippage, fee, cooldown, keeper] = validatePolicy();
    const immediate = currentHealth !== undefined && currentHealth !== (2n ** 256n - 1n) && currentHealth < trigger;
    $("policySummary").textContent = `${immediate ? "Warning: this policy is actionable at the current health. · " : ""}Act below ${formatUnits(trigger, 18)}× · target ${formatUnits(target, 18)}× · cap ${formatUnits(collateral, 6)} FXRP · ${formatUnits(slippage, 2)}% slippage · ${formatUnits(fee, 2)}% keeper fee · ${cooldown}s cooldown · keeper ${short(keeper)}`;
    $("policySummary").className = immediate ? "policy-summary warning" : "policy-summary";
  } catch (error) {
    $("policySummary").textContent = error.message;
    $("policySummary").className = "policy-summary warning";
  }
}

async function sendAuthorization() {
  if (!ENABLE_WRITES) return setStatus("Enrollment writes are disabled in this build.", "warning");
  if (!isFlare() && !(await switchToFlare())) return;
  try { setStatus("Waiting for Morpho authorization confirmation…"); const hash = await walletClient.writeContract({ address: MORPHO, abi: morphoAbi, functionName: "setAuthorization", args: [MANAGER, true], account, chain: flare }); setStatus(`Authorization submitted: ${short(hash)} · ${explorer(hash)}`); await publicClient.waitForTransactionReceipt({ hash }); await refresh(); setStatus("Morpho authorization confirmed.", "success"); }
  catch (error) { setStatus(error.shortMessage || error.message, "error"); }
}

async function disablePolicy() {
  if (!ENABLE_WRITES) return setStatus("Enrollment writes are disabled in this build.", "warning");
  if (!isFlare() && !(await switchToFlare())) return;
  if (!window.confirm("Disable Ballast protection for this Morpho market? Keepers will no longer be able to act.")) return;
  try {
    setStatus("Waiting for policy-disable confirmation…");
    const hash = await walletClient.writeContract({ address: MANAGER, abi: managerAbi, functionName: "disablePolicy", args: [MARKET_ID], account, chain: flare });
    setStatus(`Policy disable submitted: ${short(hash)} · ${explorer(hash)}`);
    await publicClient.waitForTransactionReceipt({ hash });
    await refresh();
    setStatus("Ballast policy disabled. You can now revoke Morpho authorization.", "success");
  } catch (error) { setStatus(error.shortMessage || error.message, "error"); }
}

async function revokeAuthorization() {
  if (!ENABLE_WRITES) return setStatus("Enrollment writes are disabled in this build.", "warning");
  if (!isFlare() && !(await switchToFlare())) return;
  if (!window.confirm("Revoke Ballast's Morpho authorization for this wallet?")) return;
  try {
    setStatus("Waiting for authorization-revocation confirmation…");
    const hash = await walletClient.writeContract({ address: MORPHO, abi: morphoAbi, functionName: "setAuthorization", args: [MANAGER, false], account, chain: flare });
    setStatus(`Authorization revoke submitted: ${short(hash)} · ${explorer(hash)}`);
    await publicClient.waitForTransactionReceipt({ hash });
    await refresh();
    setStatus("Morpho authorization revoked.", "success");
  } catch (error) { setStatus(error.shortMessage || error.message, "error"); }
}

async function submitPolicy(event) {
  event.preventDefault(); updateSummary();
  if (!ENABLE_WRITES) return setStatus("Enrollment writes are disabled in this build.", "warning");
  if (!isAuthorized) return setStatus("Authorize the V3 manager on Morpho before saving a policy.", "warning");
  if (!isFlare() && !(await switchToFlare())) return;
  try { const args = validatePolicy(); if (MANAGER_VERSION !== "v3") throw new Error("Enrollment writes require VITE_MANAGER_VERSION=v3."); setStatus("Waiting for policy confirmation…"); const hash = await walletClient.writeContract({ address: MANAGER, abi: managerAbi, functionName: "setPolicy", args, account, chain: flare }); setStatus(`Policy submitted: ${short(hash)} · ${explorer(hash)}`); await publicClient.waitForTransactionReceipt({ hash }); await refresh(); setStatus("Protection policy confirmed onchain.", "success"); }
  catch (error) { setStatus(error.shortMessage || error.message, "error"); }
}

$("connectButton").addEventListener("click", connect);
$("refreshButton").addEventListener("click", () => refresh().catch((error) => setStatus(error.shortMessage || error.message, "error")));
$("authorizeButton").addEventListener("click", sendAuthorization);
$("disablePolicyButton").addEventListener("click", disablePolicy);
$("revokeAuthorizationButton").addEventListener("click", revokeAuthorization);
$("policyForm").addEventListener("submit", submitPolicy);
[...document.querySelectorAll("input")].forEach((input) => input.addEventListener("input", updateSummary));
if (window.ethereum) {
  window.ethereum.on?.("chainChanged", (chainId) => {
    currentChainId = Number.parseInt(chainId, 16);
    if (account) refresh().catch((error) => setStatus(error.shortMessage || error.message, "error"));
  });
  window.ethereum.on?.("accountsChanged", (accounts) => {
    if (!accounts.length) return resetAccount();
    account = getAddress(accounts[0]);
    renderAccount();
    refresh().catch((error) => setStatus(error.shortMessage || error.message, "error"));
  });
}
updateSummary();
