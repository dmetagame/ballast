import { initMotion } from "./motion.js";

const teardown = initMotion();

// Vite HMR only; a production page never unmounts. Present so the teardown path is exercised
// during development rather than discovered to be broken later.
if (import.meta.hot) import.meta.hot.dispose(() => teardown());
