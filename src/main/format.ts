import { FORMAT_INSTRUCTIONS, FORMAT_SCHEMA, formatPrompt, parseBlocks, renderBlocks, segment, worthFormatting } from "../core/format";

const TIMEOUT_MS = 2500;

/**
 * Paragraphs and lists for a finished transcript. Returns null when the text is too short to
 * bother, or the model is slow or answers nonsense — the caller then pastes the text as is.
 * @param pauses character offsets in `text` where the speaker paused for a while.
 */
export async function formatTranscript(apiKey: string, model: string, text: string, pauses: number[]): Promise<string | null> {
  const segments = segment(text, pauses);
  if (!worthFormatting(segments)) return null;
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: FORMAT_INSTRUCTIONS },
      { role: "user", content: formatPrompt(segments) },
    ],
    response_format: { type: "json_schema", json_schema: { name: "layout", strict: true, schema: FORMAT_SCHEMA } },
  };
  // Reasoning models: skip thinking, the structure is easy and latency is what matters.
  if (/^gpt-5/.test(model)) body.reasoning_effort = "none";
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn("format:", res.status, await res.text().catch(() => ""));
      return null;
    }
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const blocks = parseBlocks(json.choices?.[0]?.message?.content ?? "", segments.length);
    return blocks ? renderBlocks(blocks, segments) : null;
  } catch (e) {
    console.warn("format:", (e as Error).message);
    return null;
  }
}
