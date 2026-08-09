import { defineChain } from "viem";

export const flare = defineChain({
  id: 14,
  name: "Flare",
  nativeCurrency: { name: "Flare", symbol: "FLR", decimals: 18 },
  rpcUrls: { default: { http: ["https://flare-api.flare.network/ext/C/rpc"] } },
  blockExplorers: { default: { name: "Flare Explorer", url: "https://flare-explorer.flare.network" } },
});

export const MORPHO = "0xF4346F5132e810f80a28487a79c7559d9797E8B0";
export const MANAGER = import.meta.env.VITE_BALLAST_MANAGER || "0x379e5B8Cf31fC5D46aEc2fc17F17708951015571";
export const MARKET_ID = "0x2f31ab3fc12d6d10d1de9e5c74053126f03ac1f80a2e6d69d36a411fef7d942f";
export const ENABLE_WRITES = import.meta.env.VITE_ENABLE_ENROLLMENT_WRITES === "true";
export const MANAGER_VERSION = import.meta.env.VITE_MANAGER_VERSION || "v1";

const policyComponentsV1 = [
    { name: "triggerHealth", type: "uint128" }, { name: "targetHealth", type: "uint128" }, { name: "maxCollateralPerAction", type: "uint64" }, { name: "maxSlippageBps", type: "uint32" }, { name: "keeperFeeBps", type: "uint32" }, { name: "cooldown", type: "uint32" }, { name: "lastAction", type: "uint64" }, { name: "enabled", type: "bool" },
];
const policyComponentsV3 = [...policyComponentsV1, { name: "keeper", type: "address" }];

export const managerAbiV1 = [
  { type: "function", name: "MORPHO", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "policyOf", stateMutability: "view", inputs: [{ name: "borrower", type: "address" }, { name: "id", type: "bytes32" }], outputs: [{ type: "tuple", components: policyComponentsV1 }] },
  { type: "function", name: "setPolicy", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }, { name: "triggerHealth", type: "uint128" }, { name: "targetHealth", type: "uint128" }, { name: "maxCollateralPerAction", type: "uint64" }, { name: "maxSlippageBps", type: "uint32" }, { name: "keeperFeeBps", type: "uint32" }, { name: "cooldown", type: "uint32" }], outputs: [] },
];

export const managerAbiV3 = [
  { type: "function", name: "MORPHO", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "policyOf", stateMutability: "view", inputs: [{ name: "borrower", type: "address" }, { name: "id", type: "bytes32" }], outputs: [{ type: "tuple", components: policyComponentsV3 }] },
  { type: "function", name: "setPolicy", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }, { name: "triggerHealth", type: "uint128" }, { name: "targetHealth", type: "uint128" }, { name: "maxCollateralPerAction", type: "uint64" }, { name: "maxSlippageBps", type: "uint32" }, { name: "keeperFeeBps", type: "uint32" }, { name: "cooldown", type: "uint32" }, { name: "keeper", type: "address" }], outputs: [] },
];

export const managerAbi = MANAGER_VERSION === "v3" ? managerAbiV3 : managerAbiV1;

export const morphoAbi = [
  { type: "function", name: "isAuthorized", stateMutability: "view", inputs: [{ name: "authorizer", type: "address" }, { name: "authorized", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "setAuthorization", stateMutability: "nonpayable", inputs: [{ name: "authorized", type: "address" }, { name: "newIsAuthorized", type: "bool" }], outputs: [] },
];
