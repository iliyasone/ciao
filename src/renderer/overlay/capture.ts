// Microphone → 24 kHz PCM16 chunks (40 ms) → main process. Lives in the (hidden) overlay window.
// One mic graph serves both uses: while a dictation runs, chunks go to it; otherwise, if the
// wake word is on, they go to the local wake-word detector. The mic is closed when neither needs it.

let ctx: AudioContext | null = null;
let moduleReady: Promise<void> | null = null;

interface Mic {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
  sink: GainNode;
}

let mic: Mic | null = null;
let opening: Promise<Mic> | null = null;
let activeSeq: number | null = null;
let wakeOn = false;
let onFlushed: (() => void) | null = null;

/** Latest mean absolute sample level (0..32768) of the dictation, read by the UI without re-rendering. */
export const meter = { level: 0 };

async function context(): Promise<AudioContext> {
  ctx ??= new AudioContext({ sampleRate: 24_000, latencyHint: "interactive" });
  moduleReady ??= ctx.audioWorklet.addModule("./pcm-worklet.js");
  await moduleReady;
  if (ctx.state !== "running") await ctx.resume();
  return ctx;
}

function onAudio(e: MessageEvent<{ pcm?: ArrayBuffer; level?: number; flushed?: boolean }>): void {
  const { pcm, level, flushed } = e.data;
  if (pcm) {
    if (activeSeq !== null) {
      meter.level = level ?? 0;
      ciao.capture.chunk(activeSeq, pcm);
    } else if (wakeOn) {
      ciao.wake.chunk(pcm);
    }
  }
  if (flushed) onFlushed?.();
}

function openMic(): Promise<Mic> {
  if (mic) return Promise.resolve(mic);
  opening ??= (async () => {
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
    node.port.onmessage = onAudio;
    source.connect(node).connect(sink).connect(c.destination);
    mic = { stream, source, node, sink };
    return mic;
  })().finally(() => (opening = null));
  return opening;
}

function closeMic(): void {
  const m = mic;
  if (!m) return;
  mic = null;
  m.source.disconnect();
  m.node.disconnect();
  m.sink.disconnect();
  m.stream.getTracks().forEach((t) => t.stop());
  meter.level = 0;
}

/** Sends the partial last chunk so the final syllable is not lost. */
function flush(m: Mic): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 300);
    onFlushed = () => {
      clearTimeout(timer);
      onFlushed = null;
      resolve();
    };
    m.node.port.postMessage("flush");
  });
}

export async function startCapture(seq: number): Promise<void> {
  activeSeq = seq;
  try {
    await openMic();
    if (activeSeq !== seq && !wakeOn) closeMic(); // stopped while the mic was opening
  } catch (e) {
    if (activeSeq === seq) activeSeq = null;
    ciao.capture.error(seq, (e as Error).message);
  }
}

export async function stopCapture(seq: number): Promise<void> {
  if (activeSeq !== seq) return;
  if (mic) await flush(mic);
  activeSeq = null;
  meter.level = 0;
  ciao.capture.stopped(seq);
  if (!wakeOn) closeMic();
}

export async function setWake(on: boolean): Promise<void> {
  wakeOn = on;
  if (on) {
    try {
      await openMic();
    } catch (e) {
      console.warn("wake word mic:", (e as Error).message);
    }
  } else if (activeSeq === null) {
    closeMic();
  }
}
