// Builds the on-device recognizer into build/tinyasr (shipped as resources/tinyasr, see src/main/local.ts):
//   ciao-asr(.exe)    native/asr, the helper (on macOS one binary for Apple Silicon and Intel)
//   en-ru-uk.tzf      tinyasr's English-Russian-Ukrainian model (int4, ~38 MB)
//   silero_vad.onnx   the voice activity detector it uses
//   LICENSE           tinyasr's: the GPL-3.0, which the builds are distributed under
// The model files come from github.com/dkaraush/tinyasr (GPL-3.0-or-later) at the commit native/asr/Cargo.toml pins,
// checked against their SHA-256. Needs Rust (cargo); runs on the OS it builds for.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const REV = "58acbfdfd73e31523f4d9ec80b9aae3c0e582f49";
// Published path in the repo -> SHA-256 of the file as shipped (the .gz ones unpacked).
const FILES = {
  "models/en-ru-uk.tzf.gz": "78ab8bfdf294829dcc804ec9403283bb9ce4e69483ea59812c49ea5934b7ee69",
  "models/silero_vad.onnx.gz": "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
  LICENSE: "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986",
};

const out = path.resolve("build/tinyasr");
fs.mkdirSync(out, { recursive: true });
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

for (const [src, hash] of Object.entries(FILES)) {
  const name = path.basename(src, ".gz");
  const file = path.join(out, name);
  if (fs.existsSync(file) && sha(file) === hash) continue;
  const url = `https://raw.githubusercontent.com/dkaraush/tinyasr/${REV}/${src}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(file, src.endsWith(".gz") ? zlib.gunzipSync(body) : body);
  if (sha(file) !== hash) throw new Error(`${name}: SHA-256 doesn't match`);
  console.log(`fetched ${name}`);
}

const manifest = path.resolve("native/asr/Cargo.toml");
const cargo = (...args) => execFileSync("cargo", ["build", "--release", "--bin", "ciao-asr", "--manifest-path", manifest, ...args], { stdio: "inherit" });
const target = path.resolve("native/asr/target");
if (process.platform === "darwin") {
  execFileSync("rustup", ["target", "add", "aarch64-apple-darwin", "x86_64-apple-darwin"], { stdio: "inherit" });
  const parts = ["aarch64-apple-darwin", "x86_64-apple-darwin"].map((t) => {
    cargo("--target", t);
    return path.join(target, t, "release", "ciao-asr");
  });
  execFileSync("lipo", ["-create", ...parts, "-output", path.join(out, "ciao-asr")], { stdio: "inherit" });
} else {
  cargo();
  const exe = process.platform === "win32" ? "ciao-asr.exe" : "ciao-asr";
  fs.copyFileSync(path.join(target, "release", exe), path.join(out, exe));
}
console.log(`built ${out}`);
