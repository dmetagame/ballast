import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = new URL("./dist/", import.meta.url);
const directory = fileURLToPath(dist);
const productionManager = "0x746066ace5dc89a3692137b8cde3c31328629d09";
const productionKeeper = "0xa20a59090f609329405f5dca785af9357f6965e7";
const legacyManager = "0x379e5b8cf31fc5d46aec2fc17f17708951015571";

if (!existsSync(join(directory, "index.html"))) throw new Error("run npm run build first");

function files(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const current = join(path, entry.name);
    return entry.isDirectory() ? files(current) : [current];
  });
}

const html = readFileSync(join(directory, "index.html"), "utf8").toLowerCase();
const content = files(directory)
  .filter((path) => /\.(html|js|css)$/.test(path))
  .map((path) => readFileSync(path, "utf8"))
  .join("\n")
  .toLowerCase();

function meta(name) {
  return html.match(new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`))?.[1];
}

if (meta("ballast-manager") !== productionManager) throw new Error("production V3 manager metadata is incorrect");
if (meta("ballast-keeper") !== productionKeeper) throw new Error("production keeper metadata is incorrect");
if (meta("ballast-manager-version") !== "v3") throw new Error("production manager version metadata is incorrect");
if (meta("ballast-writes-enabled") !== "true") throw new Error("production enrollment writes are not enabled");
if (!content.includes(productionManager)) throw new Error("production V3 manager is missing from the bundle");
if (content.includes(legacyManager)) throw new Error("legacy V1 manager is present in the build");
if (!content.includes(productionKeeper)) throw new Error("production keeper is missing from the bundle");
if (!content.includes("v3 enrollment enabled")) throw new Error("V3 enrollment marker is missing from the bundle");
if (!content.includes("setpolicy")) throw new Error("policy write ABI is missing from the bundle");

console.log("production build verified: finalized V3 manager and policy ABI present");
