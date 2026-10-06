import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { net, safeStorage, shell } from "electron";
import { t } from "../core/i18n";
import { initialState, mergeStates, parseState, recordEdit, sameState, serializeState, termsOf, type SyncState } from "../core/sync";
import type { SyncStatus } from "../core/types";
import { DEFAULT_SETTINGS } from "./settings";

// Terms and the prompt, synced through one file in the hidden app folder of the user's Google
// Drive (scope drive.appdata: Ciao sees only its own files there). No server of ours is involved.
// Sign-in is Google's flow for installed apps: the system browser, then a redirect to a one-off
// server on 127.0.0.1, with PKCE. The Android app reads and writes the same file (Sync.kt).

// Google Cloud project "ciao-510802", OAuth client of type "Desktop app", put in at build time
// (scripts/build-main.mjs; GitHub secrets in CI). An installed app can't keep a secret, and Google
// doesn't treat this one as one (PKCE protects the flow), but GitHub refuses pushes that hold it.
const CLIENT_ID = process.env.CIAO_GOOGLE_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.CIAO_GOOGLE_CLIENT_SECRET ?? "";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const SCOPES = `${DRIVE_SCOPE} https://www.googleapis.com/auth/userinfo.email`;
const FILE_NAME = "ciao-sync.json";
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const SYNC_EVERY_MS = 5 * 60_000;
const EDIT_DELAY_MS = 2_000;

interface Account {
  email: string;
  /** Encrypted with safeStorage when the OS offers it (base64), as is otherwise. */
  refreshToken: string;
  encrypted: boolean;
}

class SignedOut extends Error {}

export class GoogleSync {
  private readonly accountFile: string;
  private readonly stateFile: string;
  private account: Account | null = null;
  private state: SyncState;
  private access: { token: string; expires: number } | null = null;
  private status: SyncStatus = { available: GoogleSync.available(), email: null, signingIn: false, syncing: false };
  private running: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cancelSignIn: (() => void) | null = null;
  /** Bumped by signOut: a sign-in or sync still running for the old session stops at its next step. */
  private session = 0;
  private syncSession = 0;
  /** The settings' terms and prompt not yet compared with the history: edits are recorded after a pause in typing. */
  private pending: { keywords: string[]; prompt: string } | null = null;
  private editTimer: ReturnType<typeof setTimeout> | undefined;

  /** Built without the OAuth client (a fork, a build without the secrets): no sync, no card. */
  static available(): boolean {
    return !!CLIENT_ID && !!CLIENT_SECRET;
  }

  constructor(
    dir: string,
    current: { keywords: string[]; prompt: string },
    /** Puts merged terms and prompt into the settings (which then come back through noteLocal). */
    private readonly apply: (keywords: string[], prompt: string) => void,
    private readonly changed: (status: SyncStatus) => void,
  ) {
    this.accountFile = path.join(dir, "google-account.json");
    this.stateFile = path.join(dir, "sync-state.json");
    try {
      this.account = JSON.parse(fs.readFileSync(this.accountFile, "utf8")) as Account;
      this.status.email = this.account.email;
    } catch {
      // Not signed in.
    }
    let saved: SyncState | null = null;
    try {
      saved = parseState(fs.readFileSync(this.stateFile, "utf8"));
    } catch {
      // Never synced: what's in the settings now predates any edit to come.
    }
    this.state = saved ?? initialState(current.keywords, current.prompt, DEFAULT_SETTINGS);
    if (!saved) this.saveState();
    // Settings changed while Ciao wasn't running (config.json edited by hand) count as an edit now.
    this.pending = current;
    this.flushEdit();
    if (!GoogleSync.available()) {
      this.account = null;
      this.status.email = null;
      return;
    }
    setInterval(() => this.syncSoon(0), SYNC_EVERY_MS).unref();
    this.syncSoon(0);
  }

  get(): SyncStatus {
    return this.status;
  }

  /**
   * The settings now hold these terms and prompt. What the user changed is recorded once typing
   * pauses (not "K", "Ku", "Kub"… as removed terms), or before a sync merges, then sent.
   */
  noteLocal(keywords: string[], prompt: string): void {
    this.pending = { keywords, prompt };
    clearTimeout(this.editTimer);
    this.editTimer = setTimeout(() => {
      if (this.flushEdit()) this.syncSoon(0);
    }, EDIT_DELAY_MS);
  }

  /** Records the pending edit, if it changes anything. */
  private flushEdit(): boolean {
    clearTimeout(this.editTimer);
    const pending = this.pending;
    this.pending = null;
    const next = pending && recordEdit(this.state, pending.keywords, pending.prompt, Date.now());
    if (!next) return false;
    this.state = next;
    this.saveState();
    return true;
  }

  /** Syncs after `delayMs` (a burst of edits goes out once); nothing when signed out. */
  syncSoon(delayMs: number): void {
    if (!this.account) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.sync(), delayMs);
  }

  /** Opens Google's consent page in the browser; signOut() cancels a sign-in still waiting there. */
  async signIn(): Promise<void> {
    if (this.status.signingIn) return;
    const session = ++this.session;
    const alive = () => {
      if (session !== this.session) throw new Cancelled();
    };
    this.set({ signingIn: true, error: undefined });
    try {
      const tokens = await this.authorize();
      alive();
      if (!tokens.refresh_token) throw new Error("Google returned no refresh token");
      // Google's page lists Drive access as a box to tick, unticked at first.
      if (!tokens.scope.split(" ").includes(DRIVE_SCOPE)) throw new Error(t().sync.noDrive);
      this.access = { token: tokens.access_token, expires: Date.now() + tokens.expires_in * 1000 };
      const email = await this.email();
      alive();
      const encrypted = safeStorage.isEncryptionAvailable();
      this.account = {
        email,
        refreshToken: encrypted ? safeStorage.encryptString(tokens.refresh_token).toString("base64") : tokens.refresh_token,
        encrypted,
      };
      fs.writeFileSync(this.accountFile, JSON.stringify(this.account, null, 2), { mode: 0o600 });
      console.log("google sync: signed in");
      this.set({ email, signingIn: false });
    } catch (e) {
      if (session !== this.session) return; // cancelled: signOut has reset the status
      console.warn("google sign-in:", e);
      this.set({ signingIn: false, error: e instanceof Cancelled ? undefined : t().sync.signInFailed(message(e)) });
      return;
    }
    await this.sync();
  }

  /**
   * Forgets the account here; the terms stay. Not a revoke: Google keeps one grant per app and
   * account, so revoking would sign out every other device too.
   */
  signOut(): void {
    this.session++;
    this.cancelSignIn?.();
    this.account = null;
    this.access = null;
    clearTimeout(this.timer);
    fs.rmSync(this.accountFile, { force: true });
    this.status = { available: this.status.available, email: null, signingIn: false, syncing: false };
    this.changed(this.get());
  }

  /** One sync at a time; a request while one runs makes it run once more. */
  sync(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.syncOnce();
      } while (this.again && this.account);
    })().finally(() => (this.running = null));
    return this.running;
  }

  private async syncOnce(): Promise<void> {
    this.flushEdit();
    if (!this.account) return;
    this.syncSession = this.session;
    this.set({ syncing: true });
    try {
      const files = await this.drive<{ files: { id: string }[] }>(
        `${DRIVE}?spaces=appDataFolder&q=${encodeURIComponent(`name='${FILE_NAME}'`)}&orderBy=createdTime&fields=files(id)`,
      );
      // Two devices that synced for the first time at once may each have created the file.
      let remote: SyncState | null = null;
      for (const { id } of files.files) {
        const parsed = parseState(await this.drive<string>(`${DRIVE}/${id}?alt=media`, {}, "text"));
        // Written by a newer Ciao: leave it alone rather than overwrite what this one can't read.
        if (!parsed) throw new Error(t().sync.newerFormat);
        remote = remote ? mergeStates(remote, parsed) : parsed;
      }
      this.flushEdit(); // typed while downloading
      const merged = remote ? mergeStates(this.state, remote) : this.state;
      if (!sameState(merged, this.state)) {
        this.state = merged;
        this.saveState();
        this.apply(termsOf(merged), merged.prompt.value);
      }
      const [first, ...extra] = files.files;
      if (!remote || !sameState(merged, remote) || extra.length) {
        const body = serializeState(merged);
        if (first) {
          await this.drive(`${UPLOAD}/${first.id}?uploadType=media`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body });
        } else {
          const boundary = crypto.randomUUID();
          const multipart =
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
            JSON.stringify({ name: FILE_NAME, parents: ["appDataFolder"] }) +
            `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
          await this.drive(`${UPLOAD}?uploadType=multipart`, { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body: multipart });
        }
        for (const { id } of extra) await this.drive(`${DRIVE}/${id}`, { method: "DELETE" }, "none");
      }
      this.set({ syncing: false, syncedAt: Date.now(), error: undefined });
    } catch (e) {
      if (e instanceof Cancelled || this.syncSession !== this.session) return; // signed out meanwhile
      if (e instanceof SignedOut) {
        console.warn("google sync: access revoked, signing out");
        this.signOut();
        this.set({ error: t().sync.signedOut });
        return;
      }
      console.warn("google sync:", e);
      this.set({ syncing: false, error: t().sync.failed(message(e)) });
    }
  }

  private async drive<T>(url: string, init: RequestInit = {}, as: "json" | "text" | "none" = "json"): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.token();
      // Signed out (perhaps into another account) since this sync started: its data must not go there.
      if (this.syncSession !== this.session) throw new Cancelled();
      const res = await net.fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } });
      if (this.syncSession !== this.session) throw new Cancelled();
      if (res.status === 401 && attempt === 0) {
        this.access = null; // expired early, or revoked: a fresh token tells which
        continue;
      }
      if (!res.ok) throw new Error(`Google Drive ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return (as === "json" ? await res.json() : as === "text" ? await res.text() : undefined) as T;
    }
  }

  private async token(): Promise<string> {
    if (this.access && this.access.expires > Date.now() + 60_000) return this.access.token;
    if (!this.account) throw new Cancelled();
    const res = await net.fetch(
      "https://oauth2.googleapis.com/token",
      form({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "refresh_token", refresh_token: this.refreshToken(this.account) }),
    );
    const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
    if (body.error === "invalid_grant") throw new SignedOut();
    if (!res.ok || !body.access_token) throw new Error(`Google sign-in ${res.status}: ${body.error ?? ""}`);
    this.access = { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return this.access.token;
  }

  private refreshToken(account: Account): string {
    return account.encrypted ? safeStorage.decryptString(Buffer.from(account.refreshToken, "base64")) : account.refreshToken;
  }

  private async email(): Promise<string> {
    const res = await net.fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${this.access!.token}` } });
    if (!res.ok) throw new Error(`Google userinfo ${res.status}`);
    return ((await res.json()) as { email: string }).email;
  }

  /** The browser part: consent in the system browser, the code back on 127.0.0.1, then tokens. */
  private async authorize(): Promise<{ access_token: string; expires_in: number; refresh_token?: string; scope: string }> {
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const state = crypto.randomBytes(16).toString("base64url");
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const redirect = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const code = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(t().sync.timedOut)), SIGN_IN_TIMEOUT_MS);
        this.cancelSignIn = () => {
          clearTimeout(timeout);
          reject(new Cancelled());
        };
        server.on("request", (req, res) => {
          const url = new URL(req.url ?? "/", redirect);
          if (url.pathname !== "/" || url.searchParams.get("state") !== state) {
            res.writeHead(404).end();
            return;
          }
          const code = url.searchParams.get("code");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            `<!doctype html><meta charset="utf-8"><title>Ciao</title>` +
              `<body style="font:16px system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0">` +
              `<p>${t().sync.browserDone}</p>`,
          );
          clearTimeout(timeout);
          if (code) resolve(code);
          else reject(url.searchParams.get("error") === "access_denied" ? new Cancelled() : new Error(url.searchParams.get("error") ?? "no code"));
        });
        const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        auth.search = new URLSearchParams({
          client_id: CLIENT_ID,
          redirect_uri: redirect,
          response_type: "code",
          scope: SCOPES,
          code_challenge: challenge,
          code_challenge_method: "S256",
          state,
          access_type: "offline",
          // A refresh token comes only with a fresh consent, so ask again even if Ciao was allowed before.
          prompt: "consent",
        }).toString();
        void shell.openExternal(auth.toString());
      });
      const res = await net.fetch(
        "https://oauth2.googleapis.com/token",
        form({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirect }),
      );
      if (!res.ok) throw new Error(`Google token ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string; scope: string };
    } finally {
      this.cancelSignIn = null;
      server.closeAllConnections();
      server.close();
    }
  }

  private saveState(): void {
    fs.writeFileSync(this.stateFile, serializeState(this.state));
  }

  private set(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    this.changed(this.get());
  }
}

class Cancelled extends Error {}

function form(fields: Record<string, string>): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
