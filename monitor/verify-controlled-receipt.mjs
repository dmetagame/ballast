#!/usr/bin/env node
import {
  createPublicClient,
  decodeFunctionData,
  decodeEventLog,
  getAddress,
  http,
  parseAbi,
  toFunctionSelector,
} from "viem";

const RPC_URL = process.env.RPC_URL || "https://flare-api.flare.network/ext/C/rpc";
const FLARE_CHAIN_ID = 14;
const MANAGER = getAddress("0x746066ACe5dc89a3692137b8cdE3c31328629d09");
const PRODUCTION_KEEPER = getAddress("0xA20a59090f609329405F5DcA785Af9357F6965E7");
const MORPHO = getAddress("0xF4346F5132e810f80a28487a79c7559d9797E8B0");
const FXRP = getAddress("0xAd552A648C74D49E10027AB8a618A3ad4901c5bE");
const USDT0 = getAddress("0xe7cd86e13AC4309349F30B3435a9d337750fC82D");
const MARKET_ID = "0x2f31ab3fc12d6d10d1de9e5c74053126f03ac1f80a2e6d69d36a411fef7d942f";
const PROTECT_SELECTOR = toFunctionSelector("protect(address,bytes32)");
const transactionHash = process.env.PROTECTION_TX;
const borrower = process.env.BORROWER ? getAddress(process.env.BORROWER) : null;
const expectCleanup = process.env.EXPECT_CLEANUP === "true";

if (!transactionHash || !/^0x[0-9a-f]{64}$/i.test(transactionHash)) throw new Error("PROTECTION_TX is required");
if (!borrower) throw new Error("BORROWER is required");

const client = createPublicClient({ transport: http(RPC_URL) });
const managerAbi = parseAbi([
  "event Protected(address indexed borrower, bytes32 indexed id, address indexed keeper, uint256 healthBefore, uint256 healthAfter, uint256 repaidAssets, uint256 collateralSold, uint256 surplusReturned, uint256 keeperFee)",
  "function protect(address borrower, bytes32 id)",
  "function policyOf(address borrower, bytes32 id) view returns (uint128 triggerHealth, uint128 targetHealth, uint64 maxCollateralPerAction, uint32 maxSlippageBps, uint32 keeperFeeBps, uint32 cooldown, uint64 lastAction, bool enabled, address keeper)",
]);
const morphoAbi = parseAbi([
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function isAuthorized(address authorizer, address authorized) view returns (bool)",
]);
const tokenAbi = parseAbi(["function balanceOf(address account) view returns (uint256)"]);

const receipt = await client.getTransactionReceipt({ hash: transactionHash });
if (receipt.status !== "success") throw new Error("protection transaction did not succeed");
const transaction = await client.getTransaction({ hash: transactionHash });
const chainId = await client.getChainId();
if (chainId !== FLARE_CHAIN_ID) throw new Error(`expected Flare chain ${FLARE_CHAIN_ID}, received ${chainId}`);
if (!transaction.to || getAddress(transaction.to) !== MANAGER) throw new Error("protection transaction target mismatch");
if (getAddress(transaction.from) !== PRODUCTION_KEEPER) throw new Error("protection transaction was not sent by the production keeper");
if (transaction.input.slice(0, 10).toLowerCase() !== PROTECT_SELECTOR.toLowerCase()) {
  throw new Error("protection transaction did not call protect(address,bytes32)");
}
const call = decodeFunctionData({ abi: managerAbi, data: transaction.input });
if (call.functionName !== "protect" || getAddress(call.args[0]) !== borrower || call.args[1].toLowerCase() !== MARKET_ID) {
  throw new Error("protection transaction calldata mismatch");
}

const protectedEvents = receipt.logs.flatMap((log) => {
  if (log.address.toLowerCase() !== MANAGER.toLowerCase()) return [];
  try {
    const decoded = decodeEventLog({ abi: managerAbi, data: log.data, topics: log.topics });
    return decoded.eventName === "Protected" ? [decoded.args] : [];
  } catch {
    return [];
  }
});
if (protectedEvents.length !== 1) throw new Error(`expected one Protected event, found ${protectedEvents.length}`);

const event = protectedEvents[0];
if (getAddress(event.borrower) !== borrower) throw new Error("Protected borrower mismatch");
if (event.id.toLowerCase() !== MARKET_ID) throw new Error("Protected market mismatch");
if (getAddress(event.keeper) !== PRODUCTION_KEEPER) throw new Error("Protected keeper is not the production keeper");
if (event.healthAfter <= event.healthBefore) throw new Error("health did not improve");
if (event.repaidAssets === 0n || event.collateralSold === 0n || event.keeperFee === 0n) {
  throw new Error("receipt is missing nonzero protection economics");
}

const [fxrpAtReceipt, usdtAtReceipt, receiptPosition, receiptAuthorized, receiptPolicy] = await Promise.all([
  client.readContract({ address: FXRP, abi: tokenAbi, functionName: "balanceOf", args: [MANAGER], blockNumber: receipt.blockNumber }),
  client.readContract({ address: USDT0, abi: tokenAbi, functionName: "balanceOf", args: [MANAGER], blockNumber: receipt.blockNumber }),
  client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [MARKET_ID, borrower], blockNumber: receipt.blockNumber }),
  client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "isAuthorized", args: [borrower, MANAGER], blockNumber: receipt.blockNumber }),
  client.readContract({ address: MANAGER, abi: managerAbi, functionName: "policyOf", args: [borrower, MARKET_ID], blockNumber: receipt.blockNumber }),
]);
if (fxrpAtReceipt !== 0n || usdtAtReceipt !== 0n) throw new Error("manager retained tokens in the protection block");
if (!receiptAuthorized || !receiptPolicy[7] || getAddress(receiptPolicy[8]) !== PRODUCTION_KEEPER) {
  throw new Error("controlled policy was not active for the production keeper in the protection block");
}

const [latestPosition, latestAuthorized, latestPolicy] = await Promise.all([
  client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [MARKET_ID, borrower] }),
  client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "isAuthorized", args: [borrower, MANAGER] }),
  client.readContract({ address: MANAGER, abi: managerAbi, functionName: "policyOf", args: [borrower, MARKET_ID] }),
]);
if (expectCleanup) {
  const [, latestBorrowShares, latestCollateral] = latestPosition;
  if (latestBorrowShares !== 0n || latestCollateral !== 0n || latestAuthorized || latestPolicy[7]) {
    throw new Error("controlled borrower cleanup is incomplete");
  }
}

const [, receiptBorrowShares, receiptCollateral] = receiptPosition;
const [, latestBorrowShares, latestCollateral] = latestPosition;

const output = {
  transactionHash,
  chainId,
  blockNumber: receipt.blockNumber,
  borrower,
  keeper: event.keeper,
  healthBefore: event.healthBefore,
  healthAfter: event.healthAfter,
  repaidAssets: event.repaidAssets,
  collateralSold: event.collateralSold,
  surplusReturned: event.surplusReturned,
  keeperFee: event.keeperFee,
  managerFxrpBalanceAtReceipt: fxrpAtReceipt,
  managerUsdt0BalanceAtReceipt: usdtAtReceipt,
  receiptBorrowShares,
  receiptCollateral,
  receiptAuthorized,
  receiptPolicyEnabled: receiptPolicy[7],
  latestBorrowShares,
  latestCollateral,
  latestAuthorized,
  latestPolicyEnabled: latestPolicy[7],
};
console.log(JSON.stringify(output, (_, value) => typeof value === "bigint" ? value.toString() : value, 2));
