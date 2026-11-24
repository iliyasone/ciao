// The on-device recognizer (tinyasr): runs native/asr's helper, one process per dictation or recording.
// Its folder (resources/tinyasr) holds the helper and the model files: scripts/build-asr.mjs.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { app } from "electron";
import type { HelperLike } from "../core/local";

const dir = () => (app.isPackaged ? path.join(process.resourcesPath, "tinyasr") : path.join(app.getAppPath(), "build", "tinyasr"));
const bin = () => path.join(dir(), process.platform === "win32" ? "ciao-asr.exe" : "ciao-asr");

/** The helper and its models are there. */
export function localAvailable(): boolean {
  return ["en-ru-uk.tzf", "silero_vad.onnx"].every((f) => fs.existsSync(path.join(dir(), f))) && fs.existsSync(bin());
}

/**
 * Up to four threads: a file pass takes ~2.5× less time on four than on one, a live session ~1.1× (measured on a
 * Ryzen 7 4700U); more gain nothing.
 */
const THREADS = Math.max(1, Math.min(4, os.availableParallelism()));

export function spawnHelper(): HelperLike {
  const p = spawn(bin(), [path.join(dir(), "en-ru-uk.tzf"), path.join(dir(), "silero_vad.onnx"), String(THREADS)], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  let exited = false;
  const helper: HelperLike = {
    write: (line) => {
      if (!exited && p.stdin.writable) p.stdin.write(`${line}\n`);
    },
    onLine: null,
    onExit: null,
    kill: () => {
      if (!exited) p.kill();
    },
  };
  // A helper that went away mid-write: its exit says so.
  p.stdin.on("error", () => {});
  readline.createInterface({ input: p.stdout }).on("line", (line) => helper.onLine?.(line));
  p.on("error", (e) => {
    exited = true;
    helper.onExit?.(e.message);
  });
  // "close", not "exit": after the last line is read.
  p.on("close", (code) => {
    exited = true;
    helper.onExit?.(code ? `tinyasr: exit ${code}` : null);
  });
  return helper;
}
