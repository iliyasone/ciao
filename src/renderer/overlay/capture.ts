// Microphone → 24 kHz PCM16 chunks (40 ms) → main process. Lives in the (hidden) overlay window.
// One mic graph serves both uses: while a dictation runs, chunks go to it; otherwise, if the
// wake word is on, they go to the local wake-word detector. The mic is closed when neither needs it.
// It records from the microphone chosen in Settings (the system's default if none is, or it isn't
// connected), and follows devices coming and going: see refresh() and lost().

import { checkTrack, errorText, openMicStream } from "../mic";

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
/** The microphone's name from Settings; "" = the system's default. */
let wanted = "";
/** The open mic may not be the one to record from now (the choice changed, a device came or went). */
let stale = false;

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
    stale = false;
    const [stream, c] = await Promise.all([openMicStream(wanted), context()]);
    const source = c.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(c, "pcm16");
    const sink = c.createGain();
    sink.gain.value = 0; // keeps the node pulled by the graph without making a sound
    node.port.onmessage = onAudio;
    source.connect(node).connect(sink).connect(c.destination);
    const m: Mic = { stream, source, node, sink };
    const track = stream.getAudioTracks()[0];
    track?.addEventListener("ended", () => lost(m));
    mic = m;
    // Unplugged while the graph was being built: "ended" has fired already. After this open settles.
    if (track?.readyState === "ended") setTimeout(() => lost(m));
    return m;
  })().finally(() => {
    opening = null;
    if (mic && activeSeq === null && !wakeOn) closeMic(); // no longer needed (the wake word was turned off meanwhile)
    else refresh(); // the choice changed or a device came while it was opening
  });
  return opening;
}

/** Reopens a stale mic on the device to use now; while a dictation records, it waits for its end (stopCapture). */
function refresh(): void {
  if (!stale || !mic || activeSeq !== null) return;
  closeMic();
  void reopen();
}

/** The device went away (unplugged, turned off): carry on with the one to use now, mid-dictation too. */
function lost(m: Mic): void {
  if (mic !== m) return;
  closeMic();
  void reopen();
}

/**
 * Opens the mic again if a dictation or the wake word needs it. If none opens, a dictation goes on
 * without audio (what it has is still transcribed when it ends) and the next devicechange tries again.
 */
async function reopen(): Promise<void> {
  if (activeSeq === null && !wakeOn) return;
  try {
    await openMic();
  } catch (e) {
    console.warn("reopening the mic:", errorText(e));
  }
}

let deviceTimer: ReturnType<typeof setTimeout> | undefined;
navigator.mediaDevices.addEventListener("devicechange", () => {
  // Several arrive at once (a headset brings a mic and speakers): look once they have settled.
  clearTimeout(deviceTimer);
  deviceTimer = setTimeout(() => void devicesChanged(), 300);
});

async function devicesChanged(): Promise<void> {
  const m = mic;
  if (!m) {
    if (opening) stale = true; // it may have listed the devices before this change
    else void reopen(); // none could be opened before (none connected, or the reopen after an unplug failed)
    return;
  }
  const track = m.stream.getAudioTracks()[0];
  const change = track ? await checkTrack(track, wanted).catch(() => "switch" as const) : "gone";
  if (mic !== m || !change) return;
  // Gone: at once, mid-dictation too (some systems stall the stream rather than end it). A switch
  // waits for the dictation's end; between dictations a needless one loses ~0.2 s the wake word could be said in.
  if (change === "gone") {
    lost(m);
  } else {
    stale = true;
    refresh();
  }
}

/** The microphone chosen in Settings ("" = the system's default). */
export function setMicrophone(name: string): void {
  if (name === wanted) return;
  wanted = name;
  stale = true;
  refresh();
}

function closeMic(): void {
  const m = mic;
  if (!m) return;
  mic = null;
  m.source.disconnect();
  m.node.port.postMessage("close"); // lets the processor go: otherwise it lives on with each reopen
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
    ciao.capture.error(seq, errorText(e));
  }
}

export async function stopCapture(seq: number): Promise<void> {
  if (activeSeq !== seq) return;
  if (mic) await flush(mic);
  activeSeq = null;
  meter.level = 0;
  ciao.capture.stopped(seq);
  if (!wakeOn) closeMic();
  else refresh();
}

export async function setWake(on: boolean): Promise<void> {
  wakeOn = on;
  if (on) {
    try {
      await openMic();
    } catch (e) {
      console.warn("wake word mic:", errorText(e));
    }
  } else if (activeSeq === null) {
    closeMic();
  }
}
