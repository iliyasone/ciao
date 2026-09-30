// Fetches the wake-word detector for the Windows build into build/kws (shipped as resources/kws):
//   sherpa-onnx-node/     JS wrapper        } siblings: the wrapper finds the addon at
//   sherpa-onnx-win-x64/  N-API addon + DLLs }           ../sherpa-onnx-win-x64/sherpa-onnx.node
//   model/                Russian streaming zipformer (Vosk-trained, int8), no training needed
//   keywords.txt          the wake word as model tokens
// Runs on any OS; nothing is compiled.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const VERSION = "1.13.8";
const MODEL = "sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16";
const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL}.tar.bz2`;
const MODEL_FILES = ["encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx", "tokens.txt"];

const out = path.resolve("build/kws");
const tmp = path.resolve("build/kws-tmp");
fs.rmSync(out, { recursive: true, force: true });
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
fs.mkdirSync(path.join(out, "model"), { recursive: true });

for (const pkg of ["sherpa-onnx-node", "sherpa-onnx-win-x64"]) {
  const tgz = execFileSync("npm", ["pack", `${pkg}@${VERSION}`, "--silent", "--pack-destination", tmp], { encoding: "utf8", shell: process.platform === "win32" }).trim().split("\n").at(-1);
  const dest = path.join(out, pkg);
  fs.mkdirSync(dest, { recursive: true });
  execFileSync("tar", ["-xzf", path.join(tmp, tgz), "-C", dest, "--strip-components=1"]);
}

const archive = path.join(tmp, "model.tar.bz2");
const res = await fetch(MODEL_URL);
if (!res.ok) throw new Error(`model download failed: ${res.status}`);
fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
execFileSync("tar", ["-xjf", archive, "-C", tmp, ...MODEL_FILES.map((f) => `${MODEL}/${f}`)]);
for (const f of MODEL_FILES) fs.renameSync(path.join(tmp, MODEL, f), path.join(out, "model", f));

// "чао" in the model's sentencepiece tokens; the label after @ is what the spotter reports.
fs.writeFileSync(path.join(out, "keywords.txt"), "▁ ча о @чао\n");
fs.rmSync(tmp, { recursive: true, force: true });
console.log("wake word detector ready in", out);
