// The focused text field of another app, through AT-SPI (libatspi, called with koffi). Electron
// itself depends on libatspi, so it is there wherever Ciao runs; the accessibility bus may not be.
// Every call is a synchronous D-Bus round trip into the app, so all of them share one deadline.

type Fn = (...args: unknown[]) => unknown;
interface Koffi {
  load(file: string): { func(signature: string): Fn };
  struct(name: string, def: Record<string, string>): unknown;
  decode(ptr: unknown, type: unknown, len?: number): unknown;
}

// atspi-constants.h
const STATE_ACTIVE = 1;
const STATE_EDITABLE = 7;
const STATE_FOCUSED = 12;
const STATE_SHOWING = 25;
const STATE_MANAGES_DESCENDANTS = 31;
const ROLE_PASSWORD_TEXT = 40;
const MATCH_ALL = 1;
const SORT_CANONICAL = 1;

/** Longer than this it is a log or a document rather than a message. */
const MAX_LENGTH = 100_000;
/** The object replacement character: a child (a paragraph, a mention) embedded in its parent's text. */
const EMBEDDED = "￼";
/** The fallback walk's limits: a web page has thousands of nodes, each a round trip. */
const MAX_NODES = 600;
const MAX_CHILDREN = 100;

export type FieldReason = "no-field" | "too-long" | "timeout" | "unsupported";
export type FieldResult = { text: string } | { text: null; reason: FieldReason };

class Miss extends Error {
  constructor(readonly reason: FieldReason) {
    super(reason);
  }
}

type Ptr = unknown;

export class Atspi {
  private readonly f: Record<string, Fn>;
  private readonly GError: unknown;
  private readonly GArray: unknown;
  // Per read:
  private deadline = 0;
  private timeout = 0;
  private refs: Ptr[] = [];

  private constructor(private readonly koffi: Koffi, f: Record<string, Fn>) {
    this.f = f;
    this.GError = koffi.struct("CiaoGError", { domain: "uint32_t", code: "int", message: "const char *" });
    this.GArray = koffi.struct("CiaoGArray", { data: "void *", len: "uint32_t" });
    // libatspi listens on the bus to keep its cache fresh; nothing runs GLib's loop in Node, so
    // drain what queued up now and then rather than let it pile up in the bus daemon.
    setInterval(() => {
      for (let i = 0; i < 100 && f.g_main_context_iteration!(null, 0); i++);
    }, 2000).unref();
  }

  /** null when libatspi or the accessibility bus is missing. */
  static open(koffi: Koffi): Atspi | null {
    const a = koffi.load("libatspi.so.0");
    const gobject = koffi.load("libgobject-2.0.so.0");
    const glib = koffi.load("libglib-2.0.so.0");
    const fns: Record<string, [ReturnType<Koffi["load"]>, string]> = {
      atspi_init: [a, "int atspi_init(void)"],
      atspi_set_timeout: [a, "void atspi_set_timeout(int, int)"],
      atspi_get_desktop: [a, "void *atspi_get_desktop(int)"],
      atspi_accessible_get_child_count: [a, "int atspi_accessible_get_child_count(void *, _Out_ void **)"],
      atspi_accessible_get_child_at_index: [a, "void *atspi_accessible_get_child_at_index(void *, int, _Out_ void **)"],
      atspi_accessible_get_process_id: [a, "uint32_t atspi_accessible_get_process_id(void *, _Out_ void **)"],
      atspi_accessible_get_role: [a, "int atspi_accessible_get_role(void *, _Out_ void **)"],
      atspi_accessible_get_state_set: [a, "void *atspi_accessible_get_state_set(void *)"],
      atspi_state_set_new: [a, "void *atspi_state_set_new(void *)"],
      atspi_state_set_add: [a, "void atspi_state_set_add(void *, int)"],
      atspi_state_set_contains: [a, "int atspi_state_set_contains(void *, int)"],
      atspi_accessible_get_collection_iface: [a, "void *atspi_accessible_get_collection_iface(void *)"],
      atspi_match_rule_new: [a, "void *atspi_match_rule_new(void *, int, void *, int, void *, int, void *, int, int)"],
      atspi_collection_get_matches: [a, "void *atspi_collection_get_matches(void *, void *, int, int, int, _Out_ void **)"],
      atspi_accessible_get_text_iface: [a, "void *atspi_accessible_get_text_iface(void *)"],
      atspi_text_get_character_count: [a, "int atspi_text_get_character_count(void *, _Out_ void **)"],
      atspi_text_get_text: [a, "void *atspi_text_get_text(void *, int, int, _Out_ void **)"],
      atspi_accessible_get_hypertext_iface: [a, "void *atspi_accessible_get_hypertext_iface(void *)"],
      atspi_hypertext_get_link_index: [a, "int atspi_hypertext_get_link_index(void *, int, _Out_ void **)"],
      atspi_hypertext_get_link: [a, "void *atspi_hypertext_get_link(void *, int, _Out_ void **)"],
      atspi_hyperlink_get_object: [a, "void *atspi_hyperlink_get_object(void *, int, _Out_ void **)"],
      g_object_unref: [gobject, "void g_object_unref(void *)"],
      g_free: [glib, "void g_free(void *)"],
      g_error_free: [glib, "void g_error_free(void *)"],
      g_array_free: [glib, "void *g_array_free(void *, int)"],
      g_main_context_iteration: [glib, "int g_main_context_iteration(void *, int)"],
    };
    const f = Object.fromEntries(Object.entries(fns).map(([name, [lib, sig]]) => [name, lib.func(sig)]));
    // 0 = connected; 2 = no accessibility bus. Can be called only once per process.
    if (f.atspi_init!() !== 0) return null;
    return new Atspi(koffi, f);
  }

  /**
   * The text of the focused editable field in the window in front: that of process `pid` (X11),
   * or, without one (Wayland, or an app in another pid namespace like Flatpak), the app whose
   * window is active. Takes at most about `budget` ms plus one call's timeout.
   */
  /** The process whose field the last focusedText looked at (null: none found). */
  appPid: number | null = null;

  focusedText(pid: number | null, budget: number): FieldResult {
    this.appPid = null;
    this.timeout = Math.max(50, Math.min(300, budget));
    this.deadline = Date.now() + budget;
    // No longer startup grace for apps seen for the first time: a hung app must not hold us.
    this.f.atspi_set_timeout!(this.timeout, 0);
    try {
      const field = this.focusedField(pid);
      if (!field) return { text: null, reason: "no-field" };
      const states = this.own(this.timed("atspi_accessible_get_state_set", field));
      if (!this.f.atspi_state_set_contains!(states, STATE_EDITABLE)) return { text: null, reason: "no-field" };
      if (this.call("atspi_accessible_get_role", "no-field", field) === ROLE_PASSWORD_TEXT) return { text: null, reason: "no-field" };
      const text = this.read(field, 0);
      if (text === null) return { text: null, reason: "no-field" };
      return text.length > MAX_LENGTH ? { text: null, reason: "too-long" } : { text };
    } catch (e) {
      if (e instanceof Miss) return { text: null, reason: e.reason };
      throw e;
    } finally {
      for (const r of this.refs) this.f.g_object_unref!(r);
      this.refs = [];
    }
  }

  private focusedField(pid: number | null): Ptr | null {
    const desktop = this.own(this.f.atspi_get_desktop!(0));
    const apps = this.children(desktop, "unsupported"); // the registry doesn't answer: no usable a11y bus
    const own = new Set([process.pid, process.ppid]);
    const candidates = pid ? apps.filter((app) => this.call("atspi_accessible_get_process_id", "no-field", app) === pid) : [];
    for (const app of candidates.length ? candidates : apps) {
      if (!candidates.length && own.has(Number(this.call("atspi_accessible_get_process_id", "no-field", app)))) continue;
      let window: Ptr | null = null;
      try {
        window = this.children(app, "no-field").find((w) => this.has(w, STATE_ACTIVE)) ?? null;
      } catch (e) {
        if (!(e instanceof Miss) || e.reason === "timeout" || candidates.length) throw e;
        continue; // another app that is going away
      }
      if (window || candidates.length === 1) this.appPid = Number(this.call("atspi_accessible_get_process_id", "no-field", app));
      if (window) return this.focusedIn(window);
      // Matched by pid but no window says it is active (some toolkits never do): look in all of them.
      if (candidates.length === 1) return this.focusedIn(app);
    }
    return null;
  }

  /** Asks the app to search its own tree (one round trip); walks it from here if it can't. */
  private focusedIn(root: Ptr): Ptr | null {
    const collection = this.own(this.timed("atspi_accessible_get_collection_iface", root));
    if (collection) {
      const states = this.own(this.f.atspi_state_set_new!(null));
      this.f.atspi_state_set_add!(states, STATE_FOCUSED);
      const rule = this.own(this.f.atspi_match_rule_new!(states, MATCH_ALL, null, MATCH_ALL, null, MATCH_ALL, null, MATCH_ALL, 0));
      try {
        const array = this.call("atspi_collection_get_matches", "no-field", collection, rule, SORT_CANONICAL, 1, 1);
        if (array) {
          const { data, len } = this.koffi.decode(array, this.GArray) as { data: Ptr; len: number };
          const found = len ? (this.koffi.decode(data, "void *", len) as Ptr[]) : [];
          this.refs.push(...found.filter(Boolean));
          this.f.g_array_free!(array, 1);
          if (found[0]) return found[0];
        }
      } catch (e) {
        if (!(e instanceof Miss) || e.reason === "timeout") throw e;
      }
    }
    return this.walk(root);
  }

  /** Depth first through what is on screen, bounded: toolkits without Collection (Qt, GTK 4). */
  private walk(root: Ptr): Ptr | null {
    const stack = [root];
    for (let n = 0; stack.length && n < MAX_NODES; n++) {
      const node = stack.pop()!;
      const states = this.own(this.timed("atspi_accessible_get_state_set", node));
      if (this.f.atspi_state_set_contains!(states, STATE_FOCUSED)) return node;
      if (node !== root && !this.f.atspi_state_set_contains!(states, STATE_SHOWING)) continue;
      if (this.f.atspi_state_set_contains!(states, STATE_MANAGES_DESCENDANTS)) continue; // a list or table: rows only
      try {
        stack.push(...this.children(node, "no-field").reverse());
      } catch (e) {
        if (!(e instanceof Miss) || e.reason === "timeout") throw e;
      }
    }
    return null;
  }

  /**
   * The text of `obj`, with the children a web page embeds in it (paragraphs of a rich editor are
   * each a child, standing in its parent's text as one U+FFFC) put back in, one line each.
   */
  private read(obj: Ptr, depth: number): string | null {
    const text = this.own(this.timed("atspi_accessible_get_text_iface", obj));
    if (!text) return null;
    const count = Number(this.call("atspi_text_get_character_count", "no-field", text));
    if (count > MAX_LENGTH) throw new Miss("too-long");
    const raw = this.string(this.call("atspi_text_get_text", "no-field", text, 0, -1));
    if (!raw.includes(EMBEDDED) || depth > 8) return raw;
    const hypertext = this.own(this.timed("atspi_accessible_get_hypertext_iface", obj));
    if (!hypertext) return raw;
    let out = "";
    let offset = 0; // in code points, as AT-SPI counts
    let prev = "";
    for (const ch of raw) {
      if (ch === EMBEDDED) {
        const index = Number(this.call("atspi_hypertext_get_link_index", "no-field", hypertext, offset));
        const link = index >= 0 ? this.own(this.call("atspi_hypertext_get_link", "no-field", hypertext, index)) : null;
        const child = link ? this.own(this.call("atspi_hyperlink_get_object", "no-field", link, 0)) : null;
        const inner = child ? this.read(child, depth + 1) : null;
        // Two in a row are blocks (paragraphs); one inside a line is inline (a link, a mention).
        if (inner !== null) out += prev === EMBEDDED && out && !out.endsWith("\n") ? `\n${inner}` : inner;
        if (out.length > MAX_LENGTH) throw new Miss("too-long");
      } else out += ch;
      prev = ch;
      offset++;
    }
    return out;
  }

  private children(obj: Ptr, onError: FieldReason): Ptr[] {
    const n = Math.min(Number(this.call("atspi_accessible_get_child_count", onError, obj)), MAX_CHILDREN);
    const out: Ptr[] = [];
    for (let i = 0; i < n; i++) {
      const child = this.own(this.call("atspi_accessible_get_child_at_index", onError, obj, i));
      if (child) out.push(child);
    }
    return out;
  }

  private has(obj: Ptr, state: number): boolean {
    const states = this.own(this.timed("atspi_accessible_get_state_set", obj));
    return !!this.f.atspi_state_set_contains!(states, state);
  }

  /**
   * Calls a libatspi function that ends in a GError**, turning its error into a Miss. Some swallow
   * a D-Bus timeout and return a default, so a call that took the whole timeout counts as one.
   */
  private call(name: string, onError: FieldReason, ...args: unknown[]): unknown {
    const error: Ptr[] = [null];
    const start = Date.now();
    const result = this.f[name]!(...args, error);
    if (error[0]) {
      const message = String((this.koffi.decode(error[0], this.GError) as { message: string | null }).message ?? "");
      this.f.g_error_free!(error[0]);
      if (!this.slow(start) && !/time|no ?reply|did not receive/i.test(message)) throw new Miss(onError);
    }
    if (error[0] || this.slow(start)) throw new Miss("timeout");
    this.checkDeadline();
    return result;
  }

  /** The same for a function without a GError (it returns a default when the app doesn't answer). */
  private timed(name: string, ...args: unknown[]): unknown {
    const start = Date.now();
    const result = this.f[name]!(...args);
    if (this.slow(start)) {
      this.own(result);
      throw new Miss("timeout");
    }
    this.checkDeadline();
    return result;
  }

  private slow(start: number): boolean {
    return Date.now() - start >= this.timeout * 0.9;
  }

  private checkDeadline(): void {
    if (Date.now() > this.deadline) throw new Miss("timeout");
  }

  private own(obj: unknown): Ptr {
    if (obj) this.refs.push(obj);
    return obj;
  }

  /** A gchar* the caller owns. */
  private string(ptr: unknown): string {
    if (!ptr) return "";
    try {
      return this.koffi.decode(ptr, "char", -1) as string;
    } finally {
      this.f.g_free!(ptr);
    }
  }
}
