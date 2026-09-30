// PCM16 mono 24 kHz helpers — the one format used end to end.

export const SAMPLE_RATE = 24_000;
export const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;

/** 44-byte WAV header for PCM16 mono 24 kHz with the given data size. */
export function wavHeader(dataBytes: number): Uint8Array {
  const h = new DataView(new ArrayBuffer(44));
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => h.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  h.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  h.setUint32(16, 16, true);
  h.setUint16(20, 1, true); // PCM
  h.setUint16(22, 1, true); // mono
  h.setUint32(24, SAMPLE_RATE, true);
  h.setUint32(28, SAMPLE_RATE * 2, true);
  h.setUint16(32, 2, true);
  h.setUint16(34, 16, true);
  ascii(36, "data");
  h.setUint32(40, dataBytes, true);
  return new Uint8Array(h.buffer);
}

/** Mean absolute amplitude of a PCM16 chunk, 0..32768. */
export function level(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const n = pcm.byteLength >> 1;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(view.getInt16(i * 2, true));
  return n ? sum / n : 0;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 without Buffer/btoa, so the core runs in Node, browsers and React Native alike. */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  if (i < bytes.length) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + (i + 1 < bytes.length ? B64[(n >> 6) & 63]! : "=") + "=";
  }
  return out;
}
