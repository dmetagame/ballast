import { defineConfig } from "vite";
import { readFileSync } from "fs";

const figures = JSON.parse(readFileSync(new URL("./src/figures.json", import.meta.url), "utf8"));

const usd = (n) => `$${n.toLocaleString("en-US")}`;
const usdCompact = (n) =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M` : `$${Math.round(n / 1e3)}K`;

/// Injects measured figures into the markup at build time.
///
/// Deliberately build-time rather than client-side: the numbers are the argument, so they
/// must be in the served HTML and legible with JavaScript disabled. A counter animation later
/// replaces the visible text and restores it, but it never supplies it.
function injectFigures() {
  const [d10, d20, d30] = figures.drawdown;
  const tokens = {
    positions: figures.positions.toLocaleString("en-US"),
    addresses: figures.addresses.toLocaleString("en-US"),
    debt: usdCompact(figures.debt),
    debtExact: usd(figures.debt),
    collateral: usdCompact(figures.collateral),
    nearPositions: figures.nearBand.positions.toLocaleString("en-US"),
    nearDebt: usdCompact(figures.nearBand.debt),
    // Raw values for the counter tweens. The visible text stays the formatted string above;
    // these only give the animation something to interpolate toward.
    positionsRaw: String(figures.positions),
    debtRaw: String(figures.debt),
    nearPositionsRaw: String(figures.nearBand.positions),
  };
  for (const d of [d10, d20, d30]) {
    tokens[`d${d.drop}Positions`] = d.positions.toLocaleString("en-US");
    tokens[`d${d.drop}Debt`] = usdCompact(d.debt);
    tokens[`d${d.drop}Penalties`] = usdCompact(d.penalties);
    tokens[`d${d.drop}PenaltiesExact`] = usd(d.penalties);
  }

  return {
    name: "ballast-inject-figures",
    transformIndexHtml(html) {
      return html.replace(/\{\{(\w+)\}\}/g, (_, key) => {
        if (!(key in tokens)) throw new Error(`unknown figure token {{${key}}}`);
        return tokens[key];
      });
    },
  };
}

export default defineConfig({
  plugins: [injectFigures()],
  // Relative base so the built page works under any path, including a preview URL
  // subdirectory. The dashboard achieves the same property by being a single file; this
  // surface achieves it here.
  base: "./",
  build: {
    outDir: "dist",
    // Keep the motion stack in its own chunk so its cost is visible in the build output
    // rather than hidden inside one bundle. Every figure this page renders is measured, and
    // the weight it costs to render them should be measured too.
    rollupOptions: {
      output: {
        // ScrollTrigger is a separate entry point from gsap core; naming only "gsap" leaves
        // it in the app chunk and understates the motion stack's real cost.
        manualChunks: { motion: ["gsap", "gsap/ScrollTrigger"] },
      },
    },
  },
});
