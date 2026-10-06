// Bundles the Electron main and preload scripts (the renderer is built by Vite).
import { build } from "esbuild";

const common = { bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron"], sourcemap: true, logLevel: "info" };

// Google's OAuth client for sync (src/main/sync.ts): GitHub secrets in CI, the environment locally.
// Without them the app builds and runs, with sync hidden.
const define = Object.fromEntries(
  ["CIAO_GOOGLE_CLIENT_ID", "CIAO_GOOGLE_CLIENT_SECRET"].map((k) => [`process.env.${k}`, JSON.stringify(process.env[k] ?? "")]),
);
await build({ ...common, define, entryPoints: ["src/main/main.ts"], outfile: "dist/main/main.js" });
await build({ ...common, entryPoints: ["src/preload/preload.ts"], outfile: "dist/preload/preload.js" });
await build({ ...common, entryPoints: ["src/main/wakeProcess.ts"], outfile: "dist/main/wake.js" });
await build({ ...common, entryPoints: ["src/linux-input/main.ts"], outfile: "dist/main/linux-input.js" });
