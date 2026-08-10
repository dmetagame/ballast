import { defineConfig } from "vite";

export default defineConfig({
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
        manualChunks: { motion: ["gsap", "gsap/ScrollTrigger", "lenis"] },
      },
    },
  },
});
