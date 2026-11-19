import { BrowserWindow, session, type Session } from "electron";
import { chatgptAccount } from "../core/chatgpt";
import { loadKeyFile, saveKeyFile } from "./settings";

// The ChatGPT account Ciao transcribes with (core/chatgpt.ts): signed in on chatgpt.com in a window
// of Ciao's own, whose cookies stay in their own partition. The access token the account gets from
// /api/auth/session is saved as ChatGPT's key (chatgpt-token.txt, not synced) and renewed from the
// same cookies before it runs out. These requests go through Chromium, as a browser's would, and
// direct: the proxy in Settings is for the transcription requests only (main/proxy.ts).

const PARTITION = "persist:chatgpt";
const LOGIN_URL = "https://chatgpt.com/auth/login";
const SESSION_URL = "https://chatgpt.com/api/auth/session";
/** A token lasts about 10 days; it is renewed once less than this is left. */
const RENEW_BEFORE_MS = 3 * 24 * 3600_000;

let partition: Session | null = null;

function chatgptSession(): Session {
  if (!partition) {
    partition = session.fromPartition(PARTITION);
    // Google's sign-in turns away browsers that name themselves Electron: chatgpt.com sees a plain Chrome.
    partition.setUserAgent(partition.getUserAgent().replace(/ (Electron|Ciao|ciao)\/\S+/g, ""));
  }
  return partition;
}

/** The access token of the account signed in now; null when none is. Throws when chatgpt.com gave no answer to go by. */
async function currentToken(): Promise<string | null> {
  const res = await chatgptSession().fetch(SESSION_URL, { credentials: "include", signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`chatgpt.com answered ${res.status}`);
  const body = (await res.json()) as { accessToken?: string }; // a challenge page instead of JSON throws
  return body.accessToken || null;
}

/**
 * Renews the saved token once it runs out soon (`force`: now, after ChatGPT refused it). Forgets it
 * when it has run out and the account is signed out. True if the saved token changed.
 */
export async function renewToken(force = false): Promise<boolean> {
  const saved = loadKeyFile("chatgpt");
  if (!saved) return false; // signed out here: signing in saves the first one
  const expiresAt = chatgptAccount(saved)?.expiresAt ?? 0;
  if (!force && expiresAt - Date.now() > RENEW_BEFORE_MS) return false;
  let token: string | null;
  try {
    token = await currentToken();
  } catch (e) {
    console.warn("chatgpt: the token wasn't renewed:", (e as Error).message);
    return false;
  }
  // Signed out (or in anew) while the request was out: that wins.
  if (token === saved || loadKeyFile("chatgpt") !== saved) return false;
  // Signed out on chatgpt.com: the saved token may still work until it runs out.
  if (!token && expiresAt > Date.now()) return false;
  saveKeyFile("chatgpt", token ?? "");
  console.log("chatgpt:", token ? "token renewed" : "signed out; the token ran out and is forgotten");
  return true;
}

let signingIn: Promise<boolean> | null = null;
let signInWin: BrowserWindow | null = null;

/** Signs in on chatgpt.com in a window (at once if its cookies still hold a sign-in). Resolves once signed in, or false if the window was closed first. */
export function signIn(parent?: BrowserWindow): Promise<boolean> {
  if (signingIn) {
    signInWin?.focus();
    return signingIn;
  }
  signingIn = (async () => {
    const token = await currentToken().catch(() => null);
    if (token) {
      saveKeyFile("chatgpt", token);
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const win = new BrowserWindow({
        width: 500,
        height: 760,
        parent,
        title: "ChatGPT",
        autoHideMenuBar: true,
        webPreferences: { session: chatgptSession() },
      });
      signInWin = win;
      let done = false;
      const check = async () => {
        const token = done ? null : await currentToken().catch(() => null);
        if (!token || done) return;
        done = true;
        clearInterval(timer);
        saveKeyFile("chatgpt", token);
        console.log("chatgpt: signed in");
        resolve(true);
        win.close();
      };
      // After each page of the sign-in, and now and then: some steps change the page without navigating.
      const timer = setInterval(() => void check(), 2000);
      win.webContents.on("did-navigate", () => void check());
      win.on("closed", () => {
        signInWin = null;
        clearInterval(timer);
        if (done) return;
        done = true;
        resolve(false);
      });
      void win.loadURL(LOGIN_URL);
    });
  })().finally(() => (signingIn = null));
  return signingIn;
}

/** Forgets the token and the sign-in's cookies. */
export async function signOut(): Promise<void> {
  signInWin?.close();
  saveKeyFile("chatgpt", "");
  await chatgptSession().clearStorageData();
}
