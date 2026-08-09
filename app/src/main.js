import { createPublicClient, createWalletClient, custom, formatUnits, getAddress, http, parseUnits, zeroAddress } from "viem";
import { flare, ENABLE_WRITES, MANAGER, MANAGER_VERSION, MARKET_ID, MORPHO, managerAbi, morphoAbi } from "./config.js";
import "./styles.css";

const publicClient = createPublicClient({ chain: flare, transport: http() });
let walletClient;
let account;
let currentChainId;

const $ = (id) => document.getElementById(id);
const short = (value) => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "—";
const explorer = (hash) => `${flare.blockExplorers.default.url}/tx/${hash}`;
const managerExplorer = `${flare.blockExplorers.default.url}/address/${MANAGER}`;
const setStatus = (message, tone = "") => { $("statusMessage").textContent = message; $("statusMessage").className = tone; };
const isFlare = () => currentChainId === flare.id;

$("managerLink").href = managerExplorer;
$("managerLink").textContent = short(MANAGER);
$("networkLabel").textContent = ENABLE_WRITES ? "Flare mainnet · enrollment enabled by configuration" : "Flare mainnet · read-only manager";

async function connect() {
  if (!window.ethereum) { setStatus("Install a wallet such as MetaMask or Rabby to continue.", "error"); return; }
  walletClient = createWalletClient({ chain: flare, transport: custom(window.ethereum) });
  [account] = await walletClient.requestAddresses();
  currentChainId = await walletClient.getChainId();
  $("connectButton").textContent = short(account);
  $("walletBadge").textContent = short(account);
  $("walletAddress").textContent = account;
  $("refreshButton").disabled = false;
  await refresh();
  if (!isFlare()) setStatus("Wallet connected. Switch to Flare mainnet before signing.", "warning");
}

async function switchToFlare() {
  if (!walletClient) return connect();
  try { await walletClient.switchChain({ id: flare.id }); currentChainId = flare.id; await refresh(); }
  catch (error) { setStatus(error.shortMessage || error.message, "error"); }
}

async function refresh() {
  if (!account) return;
  currentChainId = walletClient ? await walletClient.getChainId() : currentChainId;
  $("chainStatus").textContent = isFlare() ? "Flare mainnet (chain 14)" : `Wrong network (chain ${currentChainId})`;
  $("chainStatus").className = isFlare() ? "good" : "bad";
  const [authorized, policy] = await Promise.all([
    publicClient.readContract({ address: MORPHO, abi: morphoAbi, functionName: "isAuthorized", args: [account, MANAGER] }),
    publicClient.readContract({ address: MANAGER, abi: managerAbi, functionName: "policyOf", args: [account, MARKET_ID] }),
  ]);
  $("authorizationStatus").textContent = authorized ? "Authorized" : "Not authorized";
  $("authorizationStatus").className = authorized ? "good" : "bad";
  $("policyStatus").textContent = policy.enabled ? `Enabled · trigger ${formatUnits(policy.triggerHealth, 18)}×` : "Not configured";
  $("policyStatus").className = policy.enabled ? "good" : "muted";
  $("authorizeButton").disabled = !ENABLE_WRITES || !isFlare() || authorized;
  $("policyButton").disabled = !ENABLE_WRITES || !isFlare();
  $("disablePolicyButton").disabled = !ENABLE_WRITES || !isFlare() || !policy.enabled;
  $("revokeAuthorizationButton").disabled = !ENABLE_WRITES || !isFlare() || !authorized || policy.enabled;
  $("authorizationHint").textContent = authorized ? "Authorization is already active for this wallet." : ENABLE_WRITES ? "The next step asks Morpho to authorize the configured manager." : "Writes are disabled for the published manager.";
  $("exitHint").textContent = !ENABLE_WRITES
    ? "Exit writes are disabled for the published manager."
    : policy.enabled
      ? "Disable the policy before revoking Morpho authorization."
      : authorized
        ? "Policy disabled. Revoking authorization is now available."
        : "Protection is disabled and Morpho authorization is revoked.";
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
  try { const [, trigger, target, collateral, slippage, fee, cooldown, keeper] = validatePolicy(); $("policySummary").textContent = `Act below ${formatUnits(trigger, 18)}× · target ${formatUnits(target, 18)}× · cap ${formatUnits(collateral, 6)} FXRP · ${formatUnits(slippage, 2)}% slippage · ${formatUnits(fee, 2)}% keeper fee · ${cooldown}s cooldown · keeper ${short(keeper)}`; }
  catch (error) { $("policySummary").textContent = error.message; }
}

async function sendAuthorization() {
  if (!ENABLE_WRITES) return setStatus("Enrollment writes are disabled for the published manager.", "warning");
  if (!isFlare()) return switchToFlare();
  try { setStatus("Waiting for Morpho authorization confirmation…"); const hash = await walletClient.writeContract({ address: MORPHO, abi: morphoAbi, functionName: "setAuthorization", args: [MANAGER, true], account, chain: flare }); setStatus(`Authorization submitted: ${short(hash)} · ${explorer(hash)}`); await publicClient.waitForTransactionReceipt({ hash }); await refresh(); setStatus("Morpho authorization confirmed.", "success"); }
  catch (error) { setStatus(error.shortMessage || error.message, "error"); }
}

async function disablePolicy() {
  if (!ENABLE_WRITES) return setStatus("Enrollment writes are disabled for the published manager.", "warning");
  if (!isFlare()) return switchToFlare();
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
  if (!ENABLE_WRITES) return setStatus("Enrollment writes are disabled for the published manager.", "warning");
  if (!isFlare()) return switchToFlare();
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
  if (!ENABLE_WRITES) return setStatus("Enrollment writes are disabled for the published manager.", "warning");
  if (!isFlare()) return switchToFlare();
  try { const args = validatePolicy(); if (MANAGER_VERSION !== "v3") throw new Error("Enrollment writes require VITE_MANAGER_VERSION=v3."); setStatus("Waiting for policy confirmation…"); const hash = await walletClient.writeContract({ address: MANAGER, abi: managerAbi, functionName: "setPolicy", args, account, chain: flare }); setStatus(`Policy submitted: ${short(hash)} · ${explorer(hash)}`); await publicClient.waitForTransactionReceipt({ hash }); await refresh(); setStatus("Protection policy confirmed onchain.", "success"); }
  catch (error) { setStatus(error.shortMessage || error.message, "error"); }
}

$("connectButton").addEventListener("click", connect);
$("refreshButton").addEventListener("click", refresh);
$("authorizeButton").addEventListener("click", sendAuthorization);
$("disablePolicyButton").addEventListener("click", disablePolicy);
$("revokeAuthorizationButton").addEventListener("click", revokeAuthorization);
$("policyForm").addEventListener("submit", submitPolicy);
[...document.querySelectorAll("input")].forEach((input) => input.addEventListener("input", updateSummary));
if (window.ethereum) window.ethereum.on?.("chainChanged", (chainId) => { currentChainId = Number.parseInt(chainId, 16); refresh().catch((error) => setStatus(error.message, "error")); });
updateSummary();
