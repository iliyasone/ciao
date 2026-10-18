// The proxy the transcription services are reached through (Settings.proxy). Ported to Android in
// android/…/Proxy.kt.

export interface ProxyAddress {
  /** As used: http://user:password@host:port. */
  href: string;
  host: string;
  port: number;
  username: string;
  password: string;
}

/**
 * An HTTP proxy from what was typed: "http://user:password@host:port", or the same without
 * "http://". Null for "" (no proxy) and for anything else (another scheme, no port).
 */
export function parseProxy(text: string): ProxyAddress | null {
  const typed = text.trim();
  if (!typed) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `http://${typed}`);
  } catch {
    return null;
  }
  // URL drops a port equal to the scheme's default: :80 has to be read from what was typed.
  const port = url.port || (/:80\/?$/.test(typed) ? "80" : "");
  if (url.protocol !== "http:" || !url.hostname || !port || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return null;
  let username: string;
  let password: string;
  try {
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    return null; // a "%" not followed by two hex digits, which Android's URI refuses too
  }
  const auth = username ? `${url.username}${url.password ? `:${url.password}` : ""}@` : "";
  return { href: `http://${auth}${url.hostname}:${port}`, host: url.hostname, port: Number(port), username, password };
}

/** For showing: the address without the password. */
export function proxyLabel(p: ProxyAddress): string {
  return `${p.username ? `${p.username}@` : ""}${p.host}:${p.port}`;
}
