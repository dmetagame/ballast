import { PRODUCTION_KEEPER, PRODUCTION_MANAGER } from "./src/production.js";

const baseUrl = (process.env.BASE_URL || "https://ballast-enrollment.vercel.app").replace(/\/$/, "");
const legacyManager = "0x379e5b8cf31fc5d46aec2fc17f17708951015571";

const response = await fetch(baseUrl, { redirect: "follow" });
if (!response.ok) throw new Error(`deployment returned ${response.status} ${response.statusText}`);
const html = await response.text();
const normalizedHtml = html.toLowerCase();

function meta(name) {
  return html.match(new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, "i"))?.[1];
}

if (meta("ballast-manager")?.toLowerCase() !== PRODUCTION_MANAGER.toLowerCase()) throw new Error("deployed manager metadata is incorrect");
if (meta("ballast-keeper")?.toLowerCase() !== PRODUCTION_KEEPER.toLowerCase()) throw new Error("deployed keeper metadata is incorrect");
if (meta("ballast-manager-version") !== "v3") throw new Error("deployed manager version is incorrect");
if (meta("ballast-writes-enabled") !== "true") throw new Error("deployed writes are not enabled");
if (!normalizedHtml.includes("controlled beta")) throw new Error("controlled-beta disclosure is missing");
if (!normalizedHtml.includes('value="1.15"') || !normalizedHtml.includes('value="100"')) throw new Error("conservative policy defaults are missing");
if (!normalizedHtml.includes('role="status"') || !normalizedHtml.includes('aria-live="polite"')) throw new Error("accessible transaction status is missing");

const assetPath = html.match(/<script[^>]+src=["']([^"']*index-[^"']*\.js)["']/i)?.[1];
if (!assetPath) throw new Error("deployment JavaScript asset was not found");
const bundleUrl = new URL(assetPath, `${baseUrl}/`);
const bundleResponse = await fetch(bundleUrl);
if (!bundleResponse.ok) throw new Error(`bundle returned ${bundleResponse.status} ${bundleResponse.statusText}`);
const bundle = (await bundleResponse.text()).toLowerCase();

if (!bundle.includes(PRODUCTION_MANAGER.toLowerCase())) throw new Error("production manager is missing from the deployed bundle");
if (!bundle.includes(PRODUCTION_KEEPER.toLowerCase())) throw new Error("production keeper is missing from the deployed bundle");
if (bundle.includes(legacyManager)) throw new Error("legacy manager is present in the deployed bundle");
if (!bundle.includes("reverted onchain")) throw new Error("reverted receipt handling is missing from the deployed bundle");

console.log(`deployment verified: ${baseUrl}`);
