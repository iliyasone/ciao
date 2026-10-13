// The start and stop sounds: two soft sine notes, rising ("ту-тун") when Ciao starts listening and
// falling ("бу-бум") when it stops. Made here rather than played from files, so they start at once.

let ctx: AudioContext | null = null;

const NOTES = { start: [587.33, 880], stop: [880, 587.33] } as const; // D5 and A5
const NOTE_S = 0.085;
const GAP_S = 0.015;
const VOLUME = 0.07;

export function playSound(kind: "start" | "stop"): void {
  ctx ??= new AudioContext({ latencyHint: "interactive" });
  if (ctx.state === "suspended") void ctx.resume();
  const t0 = ctx.currentTime + 0.005;
  NOTES[kind].forEach((freq, i) => {
    const at = t0 + i * (NOTE_S + GAP_S);
    const osc = ctx!.createOscillator();
    const gain = ctx!.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    // A quick rise and a soft tail, so neither note clicks.
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(VOLUME, at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + NOTE_S + (i ? 0.06 : 0));
    osc.connect(gain).connect(ctx!.destination);
    osc.start(at);
    osc.stop(at + NOTE_S + 0.08);
  });
}
