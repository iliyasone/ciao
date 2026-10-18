import type { Agent } from "node:http";
import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent } from "undici";
import { parseProxy } from "../core/proxy";

// The connection to the transcription services (OpenAI, Gemini) may go through an HTTP proxy
// (Settings.proxy): Gemini refuses some countries, and a proxy elsewhere lets it in. Only these
// requests use it; sync, updates and telemetry go direct.

let current: { url: string; dispatcher: ProxyAgent; agent: Agent } | null = null;

/** Sets the proxy ("" = direct). Sessions opened before keep the connection they have. */
export function setProxy(url: string): void {
  const proxy = parseProxy(url);
  if ((proxy?.href ?? "") === (current?.url ?? "")) return;
  void current?.dispatcher.close().catch(() => {});
  current = proxy ? { url: proxy.href, dispatcher: new ProxyAgent(proxy.href), agent: new HttpsProxyAgent(proxy.href) } : null;
}

/**
 * fetch() to a transcription service, through the proxy when one is set. Node's own fetch takes the
 * dispatcher of the undici package of the same major version (Electron 44: Node 24, undici 7).
 */
export const apiFetch: typeof fetch = (input, init) =>
  fetch(input, current ? ({ ...init, dispatcher: current.dispatcher } as RequestInit) : init);

/** The agent a WebSocket to a transcription service connects through; undefined = direct. */
export function wsAgent(): Agent | undefined {
  return current?.agent;
}
