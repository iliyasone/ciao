// Electron utility process: continuous keyword spotting for the wake word ("чао"), fully local.
// Started with the detector folder (resources/kws, see scripts/fetch-kws.mjs) as argv[2].
//
// in:  { type: "pcm", pcm: Uint8Array }  24 kHz mono PCM16, any chunk size
//      { type: "reset" }                  forget the audio so far (after a dictation)
// out: { type: "wake", keyword: string }
//      { type: "error", message: string }
import path from "node:path";

interface Stream {
  acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void;
}
interface Spotter {
  createStream(): Stream;
  isReady(s: Stream): boolean;
  decode(s: Stream): void;
  getResult(s: Stream): { keyword: string };
  reset(s: Stream): void;
}

type Port = { on(e: "message", cb: (e: { data: unknown }) => void): void; postMessage(m: unknown): void };
// Electron's utility process exposes parentPort; plain Node (tests) uses stdin/stdout instead.
const port: Port = (process as unknown as { parentPort?: Port }).parentPort ?? {
  on: (_e, cb) => process.on("message", (data) => cb({ data })),
  postMessage: (m) => process.send?.(m),
};

const dir = process.argv[2]!;
let kws: Spotter;
let stream: Stream;
try {
  // Loaded at runtime from resources: a native addon can't be bundled.
  const sherpa = require(path.join(dir, "sherpa-onnx-node")) as { KeywordSpotter: new (config: unknown) => Spotter };
  const model = path.join(dir, "model");
  kws = new sherpa.KeywordSpotter({
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
    // Tuned on synthetic Russian speech with noise: 84/88 hits, no false fires on
    // чай/час/чат/чекаут/какао or ordinary dictation (only "чау-чау").
    keywordsScore: 1.0,
    keywordsThreshold: 0.05,
    numTrailingBlanks: 1,
    maxActivePaths: 4,
  });
  stream = kws.createStream();
} catch (e) {
  port.postMessage({ type: "error", message: (e as Error).message });
  process.exit(1);
}

port.on("message", ({ data }) => {
  const msg = data as { type: string; pcm?: Uint8Array };
  if (msg.type === "reset") {
    stream = kws.createStream();
    return;
  }
  if (msg.type !== "pcm" || !msg.pcm) return;
  const pcm = msg.pcm;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = new Float32Array(pcm.byteLength >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  stream.acceptWaveform({ sampleRate: 24000, samples });
  while (kws.isReady(stream)) {
    kws.decode(stream);
    const { keyword } = kws.getResult(stream);
    if (keyword) {
      port.postMessage({ type: "wake", keyword });
      kws.reset(stream); // otherwise the same keyword is reported again
    }
  }
});
