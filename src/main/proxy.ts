import type { Agent } from "node:http";
import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent } from "undici";
import { parseProxy, type ProxyAddress } from "../core/proxy";
import type { ProxyCheck } from "../core/types";

// The connection to the transcription services (OpenAI, Gemini) may go through an HTTP proxy
// (Settings.proxy): Gemini refuses some countries, and a proxy elsewhere lets it in. Only these
// requests use it; sync, updates and telemetry go direct.

let current: { url: string; dispatcher: ProxyAgent; agent: Agent } | null = null;

/** Sets the proxy ("" = direct). Sessions opened before keep the connection they have. */
export function setProxy(url: string): void {
  const proxy = parseProxy(url);
  if ((proxy?.href ?? "") === (current?.url ?? "")) return;
  void current?.dispatcher.close().catch(() => {});
  if (!proxy) return void (current = null);
  current = { url: proxy.href, dispatcher: dispatcherFor(proxy), agent: new HttpsProxyAgent(proxy.href) };
}

function dispatcherFor(proxy: ProxyAddress): ProxyAgent {
  // undici sends a login from the address only with both a user and a password: "user@host" too, as token.
  const token = proxy.username ? `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}` : undefined;
  return new ProxyAgent({ uri: `http://${proxy.host}:${proxy.port}`, token });
}

/**
 * fetch() to a transcription service, through the proxy when one is set. Node's own fetch takes the
 * dispatcher of the undici package of the same major version (Electron 44: Node 24, undici 7).
 */
export const apiFetch: typeof fetch = (input, init) =>
  fetch(input, current ? ({ ...init, dispatcher: current.dispatcher } as RequestInit) : init);

/**
 * Asks Gemini for its models through the proxy `url`, without a key: any answer from Google means the
 * way through works; a 407 is the proxy refusing the login. As ApiProxy.check on Android.
 */
export async function checkProxy(url: string): Promise<ProxyCheck> {
  const proxy = parseProxy(url);
  if (!proxy) return { ok: false, badLogin: false, reason: url };
  const dispatcher = dispatcherFor(proxy);
  const started = Date.now();
  try {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", {
      signal: AbortSignal.timeout(15_000),
      dispatcher,
    } as RequestInit);
    await res.body?.cancel();
    return { ok: true, ms: Date.now() - started };
  } catch (e) {
    // The reason sits down the chain: fetch failed ← Request was cancelled ← "Proxy response (407) !== 200 when HTTP Tunneling".
    const chain: string[] = [];
    for (let x = e as (Error & { cause?: unknown }) | undefined; x instanceof Error; x = x.cause as typeof x) chain.push(x.message);
    const reason = chain.at(-1) ?? String(e);
    return { ok: false, badLogin: chain.some((m) => /\(407\)/.test(m)), reason };
  } finally {
    void dispatcher.close().catch(() => {});
  }
}

/** The agent a WebSocket to a transcription service connects through; undefined = direct. */
export function wsAgent(): Agent | undefined {
  return current?.agent;
}
