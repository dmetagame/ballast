import { createPublicClient, createWalletClient, custom, formatUnits, getAddress, http, parseUnits, zeroAddress } from "viem";
import { flare, ENABLE_WRITES, KEEPER, MANAGER, MANAGER_VERSION, MARKET_ID, MORPHO, managerAbi, morphoAbi } from "./config.js";
import "./styles.css";

const publicClient = createPublicClient({ chain: flare, transport: http() });
let walletClient;
let account;
let currentChainId;
let currentHealth;
let isAuthorized = false;
let currentPolicyEnabled = false;
let accountStateReady = false;
let transactionPending = false;
let policyFormDirty = false;
let loadedPolicyAccount;

const $ = (id) => document.getElementById(id);
const short = (value) => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "—";
const explorer = (hash) => `${flare.blockExplorers.default.url}/tx/${hash}`;
const managerExplorer = `${flare.blockExplorers.default.url}/address/${MANAGER}`;
const DEFAULT_POLICY = {
  triggerHealth: "1.15",
  targetHealth: "1.30",
  maxCollateral: "100",
  maxSlippage: "1",
  keeperFee: "0.25",
  cooldown: "3600",
  keeperAddress: KEEPER,
};
const setStatus = (message, tone = "") => { $("statusMessage").textContent = message; $("statusMessage").className = `status-bar ${tone}`; };
const isFlare = () => currentChainId === flare.id;

function updateControlState() {
  $("connectButton").disabled = transactionPending;
  $("refreshButton").disabled = transactionPending || !account;
  $("authorizeButton").disabled = transactionPending || !accountStateReady || !ENABLE_WRITES || isAuthorized;
  $("policyButton").disabled = transactionPending || !accountStateReady || !ENABLE_WRITES || !isAuthorized;
  $("disablePolicyButton").disabled = transactionPending || !accountStateReady || !ENABLE_WRITES || !currentPolicyEnabled;
  $("revokeAuthorizationButton").disabled = transactionPending || !accountStateReady || !ENABLE_WRITES || !isAuthorized || currentPolicyEnabled;
  document.querySelector(".shell")?.setAttribute("aria-busy", String(transactionPending));
}

async function runTransaction(operation) {
  if (transactionPending) return;
  const transactionAccount = account;
  transactionPending = true;
  updateControlState();
  try {
    const successMessage = await operation(transactionAccount);
    if (!successMessage) return;
    if (account !== transactionAccount) {
      if (account) await refresh();
      setStatus(`Transaction confirmed for ${short(transactionAccount)}, but the connected wallet changed. Review the current account.`, "warning");
      return;
    }
    await refresh();
    setStatus(successMessage, "success");
  } catch (error) {
    setStatus(error.shortMessage || error.message, "error");
  } finally {
    transactionPending = false;
    updateControlState();
  }
}

function assertTransactionAccount(expectedAccount) {
  if (account !== expectedAccount) throw new Error("The connected wallet changed before the transaction was submitted.");
}

function resetPolicyForm() {
  for (const [id, value] of Object.entries(DEFAULT_POLICY)) $(id).value = value;
}

function clearAccountReadouts(message = "Refreshing...") {
  currentHealth = undefined;
  isAuthorized = false;
  currentPolicyEnabled = false;
  accountStateReady = false;
  for (const id of ["authorizationStatus", "healthStatus", "policyStatus", "previewStatus"]) {
    $(id).textContent = message;
    $(id).className = "muted";
  }
  $("authorizationHint").textContent = "Refreshing authorization for this wallet.";
  $("policyHint").textContent = "Refreshing the policy for this wallet.";
  $("exitHint").textContent = "Refreshing exit controls for this wallet.";
  updateSummary();
  updateControlState();
}

async function waitForSuccess(hash, action) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${action} reverted onchain. Inspect ${explorer(hash)}`);
  return receipt;
}

function renderAccount() {
  $("connectButton").textContent = short(account);
  $("walletBadge").textContent = short(account);
  $("walletAddress").textContent = account;
  updateControlState();
}

function resetAccount() {
  account = undefined;
  currentChainId = undefined;
  currentHealth = undefined;
  isAuthorized = false;
  currentPolicyEnabled = false;
  accountStateReady = false;
  policyFormDirty = false;
  loadedPolicyAccount = undefined;
  resetPolicyForm();
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
  $("authorizationHint").textContent = "Connect your wallet to inspect authorization.";
  $("policyHint").textContent = "Authorize the finalized V3 manager on Morpho before saving a policy.";
  $("exitHint").textContent = "Connect your wallet to inspect exit controls.";
  updateControlState();
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
  const refreshAccount = account;
  accountStateReady = false;
  updateControlState();
  currentChainId = walletClient ? await walletClient.getChainId() : currentChainId;
  $("chainStatus").textContent = isFlare() ? "Flare mainnet (chain 14)" : `Wrong network (chain ${currentChainId})`;
  $("chainStatus").className = isFlare() ? "good" : "bad";
  const [authorized, policy, preview] = await Promise.all([
    publicClient.readContract({ address: MORPHO, abi: morphoAbi, functionName: "isAuthorized", args: [refreshAccount, MANAGER] }),
    publicClient.readContract({ address: MANAGER, abi: managerAbi, functionName: "policyOf", args: [refreshAccount, MARKET_ID] }),
    publicClient.readContract({ address: MANAGER, abi: managerAbi, functionName: "previewProtect", args: [refreshAccount, MARKET_ID] }),
  ]);
  if (account !== refreshAccount) return;
  const [actionable, health, repayAssets, collateralNeeded] = preview;
  if (policy.triggerHealth > 0n && (!policyFormDirty || loadedPolicyAccount !== account)) {
    $("triggerHealth").value = formatUnits(policy.triggerHealth, 18);
    $("targetHealth").value = formatUnits(policy.targetHealth, 18);
    $("maxCollateral").value = formatUnits(policy.maxCollateralPerAction, 6);
    $("maxSlippage").value = formatUnits(policy.maxSlippageBps, 2);
    $("keeperFee").value = formatUnits(policy.keeperFeeBps, 2);
    $("cooldown").value = policy.cooldown.toString();
    if (policy.keeper) $("keeperAddress").value = policy.keeper;
    policyFormDirty = false;
    loadedPolicyAccount = account;
  }
  currentHealth = health;
  isAuthorized = authorized;
  currentPolicyEnabled = policy.enabled;
  accountStateReady = true;
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
  updateControlState();
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
  await runTransaction(async (transactionAccount) => {
    if (!isFlare() && !(await switchToFlare())) return null;
    assertTransactionAccount(transactionAccount);
    setStatus("Waiting for Morpho authorization confirmation…");
    const hash = await walletClient.writeContract({ address: MORPHO, abi: morphoAbi, functionName: "setAuthorization", args: [MANAGER, true], account: transactionAccount, chain: flare });
    setStatus(`Authorization submitted: ${short(hash)} · ${explorer(hash)}`);
    await waitForSuccess(hash, "Morpho authorization");
    return "Morpho authorization confirmed.";
  });
}

async function disablePolicy() {
  if (!ENABLE_WRITES) return setStatus("Enrollment writes are disabled in this build.", "warning");
  if (!window.confirm("Disable Ballast protection for this Morpho market? Keepers will no longer be able to act.")) return;
  await runTransaction(async (transactionAccount) => {
    if (!isFlare() && !(await switchToFlare())) return null;
    assertTransactionAccount(transactionAccount);
    setStatus("Waiting for policy-disable confirmation…");
    const hash = await walletClient.writeContract({ address: MANAGER, abi: managerAbi, functionName: "disablePolicy", args: [MARKET_ID], account: transactionAccount, chain: flare });
    setStatus(`Policy disable submitted: ${short(hash)} · ${explorer(hash)}`);
    await waitForSuccess(hash, "Policy disable");
    return "Ballast policy disabled. You can now revoke Morpho authorization.";
  });
}

async function revokeAuthorization() {
  if (!ENABLE_WRITES) return setStatus("Enrollment writes are disabled in this build.", "warning");
  if (!window.confirm("Revoke Ballast's Morpho authorization for this wallet?")) return;
  await runTransaction(async (transactionAccount) => {
    if (!isFlare() && !(await switchToFlare())) return null;
    assertTransactionAccount(transactionAccount);
    setStatus("Waiting for authorization-revocation confirmation…");
    const hash = await walletClient.writeContract({ address: MORPHO, abi: morphoAbi, functionName: "setAuthorization", args: [MANAGER, false], account: transactionAccount, chain: flare });
    setStatus(`Authorization revoke submitted: ${short(hash)} · ${explorer(hash)}`);
    await waitForSuccess(hash, "Authorization revoke");
    return "Morpho authorization revoked.";
  });
}

async function submitPolicy(event) {
  event.preventDefault(); updateSummary();
  if (!ENABLE_WRITES) return setStatus("Enrollment writes are disabled in this build.", "warning");
  if (!isAuthorized) return setStatus("Authorize the V3 manager on Morpho before saving a policy.", "warning");
  await runTransaction(async (transactionAccount) => {
    if (!isFlare() && !(await switchToFlare())) return null;
    assertTransactionAccount(transactionAccount);
    const args = validatePolicy();
    if (MANAGER_VERSION !== "v3") throw new Error("Enrollment writes require VITE_MANAGER_VERSION=v3.");
    setStatus("Waiting for policy confirmation…");
    const hash = await walletClient.writeContract({ address: MANAGER, abi: managerAbi, functionName: "setPolicy", args, account: transactionAccount, chain: flare });
    setStatus(`Policy submitted: ${short(hash)} · ${explorer(hash)}`);
    await waitForSuccess(hash, "Policy update");
    policyFormDirty = false;
    return "Protection policy confirmed onchain.";
  });
}

$("connectButton").addEventListener("click", connect);
$("refreshButton").addEventListener("click", () => refresh().catch((error) => setStatus(error.shortMessage || error.message, "error")));
$("authorizeButton").addEventListener("click", sendAuthorization);
$("disablePolicyButton").addEventListener("click", disablePolicy);
$("revokeAuthorizationButton").addEventListener("click", revokeAuthorization);
$("policyForm").addEventListener("submit", submitPolicy);
[...document.querySelectorAll("input")].forEach((input) => input.addEventListener("input", () => {
  policyFormDirty = true;
  updateSummary();
}));
if (window.ethereum) {
  window.ethereum.on?.("chainChanged", (chainId) => {
    currentChainId = Number.parseInt(chainId, 16);
    if (account) {
      clearAccountReadouts();
      refresh().catch((error) => setStatus(error.shortMessage || error.message, "error"));
    }
  });
  window.ethereum.on?.("accountsChanged", (accounts) => {
    if (!accounts.length) return resetAccount();
    account = getAddress(accounts[0]);
    policyFormDirty = false;
    loadedPolicyAccount = undefined;
    resetPolicyForm();
    clearAccountReadouts();
    renderAccount();
    refresh().catch((error) => setStatus(error.shortMessage || error.message, "error"));
  });
}
updateSummary();
updateControlState();
