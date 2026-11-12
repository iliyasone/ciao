import { BYTES_PER_MS, level } from "./audio";

/**
 * Keeps long silence out of what a provider is sent: live transcription is billed per second of
 * audio, a pause to think included.
 *
 * A chunk is quiet when it is below QUIET_LEVEL and at least 18 dB below the loudest chunk of the
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

  /** The audio to send now: none in a long silence, the chunk itself, or it with the quiet just before it. */
  pass(pcm: Uint8Array): Uint8Array[] {
    const l = level(pcm);
    this.loudest = Math.max(this.loudest, l);
    if (l >= Math.min(SilenceGate.QUIET_LEVEL, this.loudest / SilenceGate.LOUDEST_RATIO)) {
      this.quietMs = 0;
      this.beforeBytes = 0;
      return [...this.before.splice(0), pcm];
    }
    this.quietMs += pcm.byteLength / BYTES_PER_MS;
    if (this.quietMs <= SilenceGate.KEEP_AFTER_MS) return [pcm];
    this.before.push(pcm);
    this.beforeBytes += pcm.byteLength;
    while (this.beforeBytes > SilenceGate.KEEP_BEFORE_MS * BYTES_PER_MS) {
      const oldest = this.before.shift()!.byteLength;
      this.beforeBytes -= oldest;
      this.dropped += oldest;
    }
    return [];
  }
}
