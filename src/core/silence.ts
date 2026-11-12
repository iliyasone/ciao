import { BYTES_PER_MS, level } from "./audio";

/**
 * Keeps long silence out of what a provider is sent: live transcription is billed per second of
 * audio, a pause to think included.
 *
 * The audio is judged in frames of 40 ms, however it arrives (the microphone gives 40 ms chunks, a
 * replay of a recording a second at once). A frame is quiet when it is below QUIET_LEVEL and at least 18 dB below the loudest frame of the
 * dictation so far, so a soft voice or a weak microphone is never taken for silence: until
 * something loud is heard, nothing is. Quiet audio still goes out for KEEP_AFTER_MS after the last
 * sound, and the KEEP_BEFORE_MS before the next sound follow with it: word endings, breaths and
 * soft first syllables stay, and the provider hears a pause of about 1.5 s where a longer one was.
 * Steady noise above QUIET_LEVEL (music, a fan) is sent whole.
 */
export class SilenceGate {
  static readonly QUIET_LEVEL = 200;
  private static readonly LOUDEST_RATIO = 8;
  static readonly KEEP_AFTER_MS = 1000;
  static readonly KEEP_BEFORE_MS = 500;
  private static readonly FRAME_BYTES = 40 * BYTES_PER_MS;

  private dropped = 0;
  private loudest = 0;
  private quietMs = 0;
  /** The latest quiet audio not sent, at most KEEP_BEFORE_MS of it. */
  private before: Uint8Array[] = [];
  private beforeBytes = 0;

  /** Audio left out so far, in bytes: what is still held would go out only with a sound to come. */
  get skipped(): number {
    return this.dropped + this.beforeBytes;
  }

  /** The audio to send now, in order: none in a long silence, the chunk itself, or parts of it and the quiet just before them. */
  pass(pcm: Uint8Array): Uint8Array[] {
    const out: Uint8Array[] = [];
    // Frames to send that follow one another go out as one piece, from here.
    let from = 0;
    for (let at = 0; at < pcm.byteLength; at += SilenceGate.FRAME_BYTES) {
      const end = Math.min(at + SilenceGate.FRAME_BYTES, pcm.byteLength);
      const frame = pcm.subarray(at, end);
      const l = level(frame);
      this.loudest = Math.max(this.loudest, l);
      if (l >= Math.min(SilenceGate.QUIET_LEVEL, this.loudest / SilenceGate.LOUDEST_RATIO)) {
        this.quietMs = 0;
        this.beforeBytes = 0;
        // Frames were held until now, so no piece is open.
        out.push(...this.before.splice(0));
        continue;
      }
      this.quietMs += frame.byteLength / BYTES_PER_MS;
      if (this.quietMs <= SilenceGate.KEEP_AFTER_MS) continue;
      if (at > from) out.push(pcm.subarray(from, at));
      from = end;
      this.before.push(frame);
      this.beforeBytes += frame.byteLength;
      while (this.beforeBytes > SilenceGate.KEEP_BEFORE_MS * BYTES_PER_MS) {
        const oldest = this.before.shift()!.byteLength;
        this.beforeBytes -= oldest;
        this.dropped += oldest;
      }
    }
    if (pcm.byteLength > from) out.push(from ? pcm.subarray(from) : pcm);
    return out;
  }
}

/** How much of a recording a live model isn't sent, in bytes. */
export function silenceIn(pcm: Uint8Array): number {
  const gate = new SilenceGate();
  gate.pass(pcm);
  return gate.skipped;
}
