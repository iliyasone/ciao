// Bundles the Electron main and preload scripts (the renderer is built by Vite).
import { build } from "esbuild";

const common = { bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron"], sourcemap: true, logLevel: "info" };

await build({ ...common, entryPoints: ["src/main/main.ts"], outfile: "dist/main/main.js" });
await build({ ...common, entryPoints: ["src/preload/preload.ts"], outfile: "dist/preload/preload.js" });
