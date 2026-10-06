// List prices per minute of audio (OpenAI: September 2026; Gemini: October 2026, Google's own
// per-minute estimate for audio in and text out).
const PER_MINUTE_USD: Record<string, number> = {
  "gpt-live-transcribe": 0.017,
  "gpt-realtime-whisper": 0.017,
  "gpt-transcribe": 0.0045,
  "gemini-3.5-transcribe-live": 0.009,
  "gemini-3.5-transcribe": 0.005,
};

export function pricePerMinute(model: string): number {
  return PER_MINUTE_USD[model] ?? 0.017;
}

export function costUsd(model: string, durationMs: number): number {
  return (pricePerMinute(model) * durationMs) / 60_000;
}

/** "0,4 ¢" under a dollar, "$1.23" above. */
export function formatCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  const cents = usd * 100;
  const digits = cents < 10 ? 1 : 0;
  return `${cents.toLocaleString("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits })} ¢`;
}
