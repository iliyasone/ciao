// Fetches the wake-word detector for the Windows build into build/kws (shipped as resources/kws).
// Two detectors (see src/main/wakeProcess.ts): Vosk hears "чао" fast, sherpa-onnx double-checks.
//   vosk/                 libvosk.dll + its MinGW runtime DLLs (called through koffi, no compilation)
//   vosk-model/           vosk-model-small-ru-0.22, trimmed for grammar mode (see below)
//   koffi/                FFI for Node, only the win32_x64 binary
//   sherpa-onnx-node/     JS wrapper        } siblings: the wrapper finds the addon at
//   sherpa-onnx-win-x64/  N-API addon + DLLs }           ../sherpa-onnx-win-x64/sherpa-onnx.node
//   model/                sherpa Russian streaming zipformer (Vosk-trained, int8)
//   keywords.txt          the wake word as sherpa model tokens
// Runs on any OS; nothing is compiled. Neither model needs training.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";

const SHERPA = "1.13.8";
const KOFFI = "2.16.3";
const SHERPA_MODEL = "sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16";
const SHERPA_MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${SHERPA_MODEL}.tar.bz2`;
const SHERPA_MODEL_FILES = ["encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx", "tokens.txt"];
const VOSK_LIB_URL = "https://github.com/alphacep/vosk-api/releases/download/v0.3.45/vosk-win64-0.3.45.zip";
const VOSK_MODEL_URL = "https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip";

const out = path.resolve("build/kws");
const tmp = path.resolve("build/kws-tmp");
fs.rmSync(out, { recursive: true, force: true });
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

/** Unpacks an npm package into build/kws/<name>. */
function npmUnpack(name, version) {
  const tgz = execFileSync("npm", ["pack", `${name}@${version}`, "--silent", "--pack-destination", tmp], { encoding: "utf8", shell: process.platform === "win32" })
    .trim()
    .split("\n")
    .at(-1);
  const dest = path.join(out, name);
  fs.mkdirSync(dest, { recursive: true });
  execFileSync("tar", ["-xzf", path.join(tmp, tgz), "-C", dest, "--strip-components=1"]);
  return dest;
}

// sherpa-onnx: wrapper + Windows addon, and its model.
npmUnpack("sherpa-onnx-node", SHERPA);
npmUnpack("sherpa-onnx-win-x64", SHERPA);
{
  const archive = path.join(tmp, "sherpa-model.tar.bz2");
  await download(SHERPA_MODEL_URL, archive);
  execFileSync("tar", ["-xjf", archive, "-C", tmp, ...SHERPA_MODEL_FILES.map((f) => `${SHERPA_MODEL}/${f}`)]);
  fs.mkdirSync(path.join(out, "model"), { recursive: true });
  for (const f of SHERPA_MODEL_FILES) fs.renameSync(path.join(tmp, SHERPA_MODEL, f), path.join(out, "model", f));
  // "чао" in the model's sentencepiece tokens; the label after @ is what the spotter reports.
  fs.writeFileSync(path.join(out, "keywords.txt"), "▁ ча о @чао\n");
}

// koffi: keep only the loader and the Windows x64 binary.
{
  const dest = npmUnpack("koffi", KOFFI);
  for (const f of fs.readdirSync(dest)) if (!["index.js", "package.json", "build", "LICENSE.txt"].includes(f)) fs.rmSync(path.join(dest, f), { recursive: true });
  const builds = path.join(dest, "build", "koffi");
  for (const f of fs.readdirSync(builds)) if (f !== "win32_x64") fs.rmSync(path.join(builds, f), { recursive: true });
}

// libvosk for Windows.
{
  const zip = path.join(tmp, "vosk-lib.zip");
  await download(VOSK_LIB_URL, zip);
  const dest = path.join(out, "vosk");
  fs.mkdirSync(dest, { recursive: true });
  for (const e of new AdmZip(zip).getEntries()) if (e.entryName.endsWith(".dll")) fs.writeFileSync(path.join(dest, path.basename(e.entryName)), e.getData());
}

/** Word list (output symbols) of an OpenFst binary, as Kaldi's words.txt. */
function fstWords(buf) {
  let o = 0;
  const i32 = () => ((o += 4), buf.readInt32LE(o - 4));
  const i64 = () => ((o += 8), Number(buf.readBigInt64LE(o - 8)));
  const str = () => {
    const n = i32();
    o += n;
    return buf.toString("utf8", o - n, o);
  };
  if (i32() !== 2125659606) throw new Error("not an OpenFst file");
  str(); // fst type
  str(); // arc type
  i32(); // version
  const flags = i32();
  o += 8; // properties
  i64(); // start state
  i64(); // number of states
  i64(); // number of arcs
  const table = () => {
    if (i32() !== 2125658996) throw new Error("bad symbol table");
    str(); // name
    i64(); // available key
    const n = i64();
    const rows = [];
    for (let k = 0; k < n; k++) rows.push(`${str()} ${i64()}`);
    return rows;
  };
  const input = flags & 1 ? table() : null;
  return `${(flags & 2 ? table() : input).join("\n")}\n`;
}

// Vosk Russian model, trimmed for grammar mode: the 31 MB language model graph/Gr.fst is unused
// there, so it is replaced by its word list (loads in ~0.5 s instead of ~1.4 s); and the acoustic
// model runs every 60 ms instead of every 210 ms (--frames-per-chunk=6), so "чао" shows up in the
// partial result ~0.1 s sooner, at ~11% of a core instead of ~5%.
{
  const zip = path.join(tmp, "vosk-model.zip");
  await download(VOSK_MODEL_URL, zip);
  const dest = path.join(out, "vosk-model");
  const keep = /^vosk-model-small-ru-0\.22\/(am\/final\.mdl|conf\/.*|graph\/(HCLr\.fst|Gr\.fst|disambig_tid\.int|phones\/word_boundary\.int)|ivector\/.*)$/;
  for (const e of new AdmZip(zip).getEntries()) {
    if (e.isDirectory || !keep.test(e.entryName)) continue;
    const rel = e.entryName.split("/").slice(1).join("/");
    if (rel === "graph/Gr.fst") {
      fs.mkdirSync(path.join(dest, "graph"), { recursive: true });
      fs.writeFileSync(path.join(dest, "graph", "words.txt"), fstWords(e.getData()));
      continue;
    }
    const file = path.join(dest, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, e.getData());
  }
  fs.appendFileSync(path.join(dest, "conf", "model.conf"), "--frames-per-chunk=6\n");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("wake word detectors ready in", out);
