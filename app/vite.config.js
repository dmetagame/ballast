import { defineConfig, loadEnv } from "vite";
import { PRODUCTION_KEEPER, PRODUCTION_MANAGER } from "./src/production.js";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const manager = env.VITE_BALLAST_MANAGER || PRODUCTION_MANAGER;
  const keeper = env.VITE_BALLAST_KEEPER || PRODUCTION_KEEPER;
  const managerVersion = env.VITE_MANAGER_VERSION || "v3";
  const writesEnabled = env.VITE_ENABLE_ENROLLMENT_WRITES === "true"
    && managerVersion === "v3"
    && manager.toLowerCase() === PRODUCTION_MANAGER.toLowerCase();

  return {
    plugins: [{
      name: "ballast-build-metadata",
      transformIndexHtml: {
        order: "pre",
        handler() {
          return [
            { tag: "meta", attrs: { name: "ballast-manager", content: manager }, injectTo: "head" },
            { tag: "meta", attrs: { name: "ballast-keeper", content: keeper }, injectTo: "head" },
            { tag: "meta", attrs: { name: "ballast-manager-version", content: managerVersion }, injectTo: "head" },
            { tag: "meta", attrs: { name: "ballast-writes-enabled", content: String(writesEnabled) }, injectTo: "head" },
          ];
        },
      },
    }],
  };
});
