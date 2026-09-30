// Electron utility process: listens for the wake word ("чао"), fully local.
// Started with the detector folder (resources/kws, see scripts/fetch-kws.mjs) as argv[2].
//
// Two detectors, because neither alone is both fast and precise:
// - Vosk (Kaldi) in grammar mode hears "чао" in its partial result ~0.1–0.2 s after the word, but
//   also fires on near words (чаю, какао, чекаут).
// - sherpa-onnx keyword spotting is precise but, streaming, ~0.6 s late (it decodes 640 ms blocks).
// So Vosk listens all the time, and when it fires, sherpa checks the last second of audio at once
// (padded with silence so it can finish). Measured on synthetic Russian speech with noise: 64/65
// words caught, ~0.2 s from the end of the word, no false starts in 14 min of ordinary dictation.
//
// in:  { type: "pcm", pcm: Uint8Array }  24 kHz mono PCM16, any chunk size
//      { type: "reset" }                  forget the audio so far (after a dictation)
// out: { type: "wake", keyword: string }
//      { type: "error", message: string }
import path from "node:path";

const RATE = 24000;
const VERIFY_S = 1.0; // audio sherpa re-checks when Vosk fires
const PAD_S = 0.6; // silence after it, so sherpa's 640 ms block completes
const KEYWORD = "чао";
// Vosk has to explain every sound with one of these words (or [unk]), so "чао" only wins when it
// really sounds like "чао"; near words absorb near misses. sherpa's check removes the rest.
const GRAMMAR = JSON.stringify([KEYWORD, "[unk]", "чай", "час", "чат", "чего", "человек", "что", "чтобы", "чуть", "через", "ща", "пока",
  "окей", "там", "так", "как", "да", "нет", "ну", "вот", "это", "чем", "часто", "чайник", "сейчас", "ещё", "очень"]);

type Port = { on(e: "message", cb: (e: { data: unknown }) => void): void; postMessage(m: unknown): void };
// Electron's utility process exposes parentPort; plain Node (tests) uses the IPC channel instead.
const port: Port = (process as unknown as { parentPort?: Port }).parentPort ?? {
  on: (_e, cb) => process.on("message", (data) => cb({ data })),
  postMessage: (m) => process.send?.(m),
};

function fail(message: string): never {
  port.postMessage({ type: "error", message });
  process.exit(1);
}

const dir = process.argv[2]!;

// ── Vosk through koffi (FFI; nothing to compile) ─────────────────────────

interface Koffi {
  load(file: string): { func(signature: string): (...args: unknown[]) => unknown };
}

type Fn<A extends unknown[], R> = (...args: A) => R;
interface VoskApi {
  setLogLevel: Fn<[number], void>;
  modelNew: Fn<[string], unknown>;
  recognizerNewGrm: Fn<[unknown, number, string], unknown>;
  acceptWaveformS: Fn<[unknown, Int16Array, number], number>;
  result: Fn<[unknown], string>;
  partialResult: Fn<[unknown], string>;
  reset: Fn<[unknown], void>;
}

function loadVosk(): VoskApi {
  const koffi = require(path.join(dir, "koffi")) as Koffi;
  const libDir = path.join(dir, "vosk");
  let lib;
  if (process.platform === "win32") {
    // Load the MinGW runtime by full path first, so the DLL search order doesn't matter.
    for (const dep of ["libgcc_s_seh-1.dll", "libwinpthread-1.dll", "libstdc++-6.dll"]) koffi.load(path.join(libDir, dep));
    lib = koffi.load(path.join(libDir, "libvosk.dll"));
  } else {
    lib = koffi.load(path.join(libDir, "libvosk.so")); // for running the tests on Linux
  }
  return {
    setLogLevel: lib.func("void vosk_set_log_level(int)") as VoskApi["setLogLevel"],
    modelNew: lib.func("void* vosk_model_new(const char*)") as VoskApi["modelNew"],
    recognizerNewGrm: lib.func("void* vosk_recognizer_new_grm(void*, float, const char*)") as VoskApi["recognizerNewGrm"],
    acceptWaveformS: lib.func("int vosk_recognizer_accept_waveform_s(void*, const int16_t*, int)") as VoskApi["acceptWaveformS"],
    result: lib.func("const char* vosk_recognizer_result(void*)") as VoskApi["result"],
    partialResult: lib.func("const char* vosk_recognizer_partial_result(void*)") as VoskApi["partialResult"],
    reset: lib.func("void vosk_recognizer_reset(void*)") as VoskApi["reset"],
  };
}

// ── sherpa-onnx keyword spotter (the check) ──────────────────────────────

interface Stream {
  acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void;
}
interface Spotter {
  createStream(): Stream;
  isReady(s: Stream): boolean;
  decode(s: Stream): void;
  getResult(s: Stream): { keyword: string };
}

function loadSpotter(): Spotter {
  const sherpa = require(path.join(dir, "sherpa-onnx-node")) as { KeywordSpotter: new (config: unknown) => Spotter };
  const model = path.join(dir, "model");
  return new sherpa.KeywordSpotter({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(model, "encoder.int8.onnx"),
        decoder: path.join(model, "decoder.onnx"),
        joiner: path.join(model, "joiner.int8.onnx"),
      },
      tokens: path.join(model, "tokens.txt"),
      numThreads: 1,
      provider: "cpu",
      debug: 0,
    },
    keywordsFile: path.join(dir, "keywords.txt"),
    keywordsScore: 1.0,
    keywordsThreshold: 0.05,
    numTrailingBlanks: 1,
    maxActivePaths: 4,
  });
}

let vosk: VoskApi;
let recognizer: unknown;
let spotter: Spotter;
try {
  vosk = loadVosk();
  vosk.setLogLevel(-1);
  const model = vosk.modelNew(path.join(dir, "vosk-model"));
  if (!model) fail("Vosk model failed to load");
  recognizer = vosk.recognizerNewGrm(model, RATE, GRAMMAR);
  spotter = loadSpotter();
} catch (e) {
  fail((e as Error).message);
}

// The last VERIFY_S of audio, for sherpa's check.
const ring = new Int16Array(Math.round(VERIFY_S * RATE));
let ringPos = 0;
let firedThisUtterance = false;

function remember(pcm: Int16Array): void {
  if (pcm.length >= ring.length) {
    ring.set(pcm.subarray(pcm.length - ring.length));
    ringPos = 0;
    return;
  }
  const first = Math.min(pcm.length, ring.length - ringPos);
  ring.set(pcm.subarray(0, first), ringPos);
  ring.set(pcm.subarray(first), 0);
  ringPos = (ringPos + pcm.length) % ring.length;
}

/** sherpa on the last second + silence, decoded right now (~80 ms). */
function confirmed(): boolean {
  const audio = new Float32Array(ring.length + Math.round(PAD_S * RATE));
  for (let i = 0; i < ring.length; i++) audio[i] = ring[(ringPos + i) % ring.length]! / 32768;
  const s = spotter.createStream();
  s.acceptWaveform({ sampleRate: RATE, samples: audio });
  while (spotter.isReady(s)) {
    spotter.decode(s);
    if (spotter.getResult(s).keyword) return true;
  }
  return false;
}

/** Vosk heard the keyword: in the partial result as soon as it appears, or in the final one. */
function voskHeard(pcm: Int16Array): boolean {
  const hasKeyword = (text: string | undefined) => !!text && text.split(" ").includes(KEYWORD);
  if (vosk.acceptWaveformS(recognizer, pcm, pcm.length)) {
    const fired = firedThisUtterance;
    firedThisUtterance = false; // end of utterance: the next one may fire again
    return !fired && hasKeyword((JSON.parse(vosk.result(recognizer)) as { text?: string }).text);
  }
  if (firedThisUtterance) return false;
  if (hasKeyword((JSON.parse(vosk.partialResult(recognizer)) as { partial?: string }).partial)) {
    firedThisUtterance = true;
    return true;
  }
  return false;
}

port.on("message", ({ data }) => {
  const msg = data as { type: string; pcm?: Uint8Array };
  if (msg.type === "reset") {
    vosk.reset(recognizer);
    firedThisUtterance = false;
    ring.fill(0);
    return;
  }
  if (msg.type !== "pcm" || !msg.pcm) return;
  const bytes = msg.pcm;
  // Copy into an aligned Int16Array (the incoming view may start at an odd offset).
  const pcm = new Int16Array(bytes.byteLength >> 1);
  new Uint8Array(pcm.buffer).set(bytes.subarray(0, pcm.length * 2));
  remember(pcm);
  if (voskHeard(pcm) && confirmed()) port.postMessage({ type: "wake", keyword: KEYWORD });
});
