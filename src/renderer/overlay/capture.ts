// Microphone → 24 kHz PCM16 chunks → main process. Lives in the (hidden) overlay window.

let ctx: AudioContext | null = null;
let moduleReady: Promise<void> | null = null;

interface Running {
  seq: number;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
  sink: GainNode;
}

let running: Running | null = null;
let starting: number | null = null;
let stopRequested: number | null = null;

/** Latest mean absolute sample level (0..32768), read by the UI without re-rendering. */
export const meter = { level: 0 };

async function context(): Promise<AudioContext> {
  ctx ??= new AudioContext({ sampleRate: 24_000, latencyHint: "interactive" });
  moduleReady ??= ctx.audioWorklet.addModule("./pcm-worklet.js");
  await moduleReady;
  if (ctx.state !== "running") await ctx.resume();
  return ctx;
}

export async function startCapture(seq: number): Promise<void> {
  starting = seq;
  try {
    const [stream, c] = await Promise.all([
      navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
      }),
      context(),
    ]);
    const source = c.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(c, "pcm16");
    const sink = c.createGain();
    sink.gain.value = 0; // keeps the node pulled by the graph without making a sound
    node.port.onmessage = (e: MessageEvent<{ pcm?: ArrayBuffer; level?: number }>) => {
      if (e.data.pcm) {
        meter.level = e.data.level ?? 0;
        ciao.capture.chunk(seq, e.data.pcm);
      }
    };
    source.connect(node).connect(sink).connect(c.destination);
    running = { seq, stream, source, node, sink };
    if (stopRequested === seq) await stopCapture(seq);
  } catch (e) {
    ciao.capture.error(seq, (e as Error).message);
  } finally {
    if (starting === seq) starting = null;
  }
}

export async function stopCapture(seq: number): Promise<void> {
  const r = running;
  if (!r || r.seq !== seq) {
    if (starting === seq) stopRequested = seq; // stop as soon as the mic is up
    return;
  }
  running = null;
  stopRequested = null;
  // Flush the partial last chunk so the final syllable is not lost.
  await new Promise<void>((resolve) => {
    const prev = r.node.port.onmessage;
    const timer = setTimeout(resolve, 300);
    r.node.port.onmessage = (e: MessageEvent<{ pcm?: ArrayBuffer; flushed?: boolean }>) => {
      prev?.call(r.node.port, e);
      if (e.data.flushed) {
        clearTimeout(timer);
        resolve();
      }
    };
    r.node.port.postMessage("flush");
  });
  r.source.disconnect();
  r.node.disconnect();
  r.sink.disconnect();
  r.stream.getTracks().forEach((t) => t.stop());
  meter.level = 0;
  ciao.capture.stopped(seq);
}
