// Records the landing page's card demo into assets/demo-{dark,light}.gif for the README.
//   npm i --no-save playwright && npx playwright install chromium
//   node site/record-demo.mjs        (needs ffmpeg on PATH)
// The fonts are whatever the machine has: the committed GIFs were recorded on Linux, without Segoe UI.
// Frames start at the full card (FULL), so a GIF that doesn't autoplay still shows the sentence.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const frames = mkdtempSync(join(tmpdir(), "ciao-demo-"));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
for (const scheme of ["dark", "light"]) {
  const page = await browser.newPage({ viewport: { width: 608, height: 150 }, colorScheme: scheme, deviceScaleFactor: 1.5 });
  await page.goto(`${pathToFileURL(join(root, "site", "index.html")).href}?gif`);
  const { LOOP, FULL } = await page.evaluate(() => window.ciaoDemo);
  let i = 0;
  for (let t = 0; t < LOOP; t += 20) {
    await page.evaluate((t) => window.ciaoDemo.render(t), (FULL + t) % LOOP);
    await page.screenshot({ path: join(frames, `${scheme}-${String(i++).padStart(4, "0")}.png`) });
  }
  await page.close();
  execFileSync("ffmpeg", [
    "-loglevel", "error", "-y", "-framerate", "50", "-i", join(frames, `${scheme}-%04d.png`),
    "-vf", "split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
    join(root, "assets", `demo-${scheme}.gif`),
  ]);
}
await browser.close();
rmSync(frames, { recursive: true });
