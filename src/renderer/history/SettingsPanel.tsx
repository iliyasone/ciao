import { Check, ChevronDown, ChevronRight, Loader2, Mic, MousePointerClick, Plus, Square, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { acceleratorFromEvent, acceleratorParts, isMouseTrigger, triggerParts } from "../../core/triggers";
import type { Strings } from "../../core/i18n";
import { pricePerMinute } from "../../core/cost";
import { models, PROVIDERS } from "../../core/providers";
import { parseProxy, proxyLabel, type ProxyAddress } from "../../core/proxy";
import { DELAYS, type Lang, type Provider, type Settings, type SyncStatus, type Theme, type UpdateState } from "../../core/types";
import { useStrings } from "../lang";
import { errorText, listMics, openMicStream, trackName } from "../mic";

const THEMES: Theme[] = ["system", "light", "dark"];

// Each language is named in itself, so it can be found whatever the current one is.
const LANGUAGES: { value: Lang; label: string }[] = [
  { value: "ru", label: "Русский" },
  { value: "en", label: "English" },
];

type Update = (patch: Partial<Settings>, debounce?: boolean) => void;
/** Why the last check of a service's key (or ChatGPT sign-in) failed; the status card shows the one in use. */
type Failed = { provider: Provider; reason: string } | null;

const displayName = (provider: Provider) => {
  const info = PROVIDERS[provider];
  return info.company === info.name ? info.name : `${info.company} ${info.name}`;
};

/**
 * The settings, in T3 Code's style and in the Android app's order (android/.../MainActivity.kt): a
 * status card that says what is missing, then sections of bordered cards with rows.
 */
export function SettingsPanel({ updateState }: { updateState: UpdateState | null }) {
  const [s, setS] = useState<Settings | null>(null);
  const [wakeAvailable, setWakeAvailable] = useState(false);
  const [canBringForward, setCanBringForward] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState<Partial<Record<Provider, string>>>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** What a pending save sends: the latest settings, including terms merged by a sync meanwhile. */
  const latest = useRef<Settings | null>(null);
  const hasKey = useHasKeys();
  // New keys (saved here or brought by sync): earlier checks, finished or still running, no longer say
  // anything about them. The event doesn't say whose key changed, so this goes for every service.
  useEffect(
    () =>
      ciao.settings.onKeys(() => {
        invalidateChecks();
        setFailed({});
      }),
    [],
  );
  const mics = useMics();
  const accessibility = useAccessibility();
  const tr = useStrings().settings;

  useEffect(() => {
    void ciao.settings.get().then((v) => {
      latest.current = v;
      setS(v);
    });
    void ciao.settings.wakeAvailable().then(setWakeAvailable);
    void ciao.settings.canBringForward().then(setCanBringForward);
    // Terms and context merged from another device replace what's shown here.
    const offSynced = ciao.settings.onSynced((synced) => {
      if (!latest.current) return;
      latest.current = { ...latest.current, keywords: synced.keywords, prompt: synced.prompt, syncKeys: synced.syncKeys, proxy: synced.proxy };
      setS(latest.current);
    });
    // A word added from a suggestion joins the list as shown, so terms being typed aren't lost.
    const offAdded = ciao.settings.onTermAdded((term) => {
      const cur = latest.current;
      if (!cur || cur.keywords.some((k) => k.trim().toLowerCase() === term.toLowerCase())) return;
      latest.current = { ...cur, keywords: [term, ...cur.keywords] };
      setS(latest.current);
    });
    // config.json edited outside Ciao: this page shows (and saves) the file's settings from now on.
    const offReloaded = ciao.settings.onReloaded((next) => {
      latest.current = next;
      setS(next);
    });
    return () => {
      offSynced();
      offAdded();
      offReloaded();
    };
  }, []);

  const update: Update = (patch, debounce = false) => {
    if (!latest.current) return;
    latest.current = { ...latest.current, ...patch };
    setS(latest.current);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(
      async () => {
        await ciao.settings.set(latest.current!);
        setSaved(true);
        setTimeout(() => setSaved(false), 1200);
      },
      debounce ? 500 : 0,
    );
  };

  if (!s) return null;
  // Each service keeps its own result: an answer for one leaves the others' as they are.
  const onChecked = (provider: Provider, reason: string | null) => setFailed((f) => ({ ...f, [provider]: reason ?? undefined }));
  const reason = failed[s.provider];

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[56rem] flex-col px-6 pt-6 pb-16">
        <StatusCard s={s} hasKey={hasKey[s.provider]} failed={reason === undefined ? null : { provider: s.provider, reason }} mics={mics} accessibility={accessibility} />

        {accessibility !== null && (
          <Section title={tr.permissions.title}>
            <Row id="setting-accessibility" title={tr.permissions.accessibility} hint={accessibility ? undefined : tr.permissions.accessibilityHint}
              control={accessibility ? <StatusText ok>{tr.permissions.granted}</StatusText> : <Button primary onClick={() => void ciao.settings.openAccessibility()}>{tr.permissions.open}</Button>}
            />
          </Section>
        )}

        <Section title={tr.recognition.title}>
          <ServiceRow s={s} hasKey={hasKey} update={update} />
          {PROVIDERS[s.provider].signIn ? <ChatGPTAccountRow onChecked={onChecked} /> : <ApiKeyRow key={s.provider} provider={s.provider} hasKey={hasKey[s.provider] ?? true} onChecked={onChecked} />}
          {/* OpenAI only: the others detect the language themselves. */}
          {s.provider === "openai" && (
            <Row title={tr.recognition.languages} hint={tr.recognition.languagesHint}
              control={<input value={s.languages.join(", ")} onChange={(e) => update({ languages: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) }, true)} className={`${INPUT} w-[18rem]`} />}
            />
          )}
          <ProxyRow value={s.proxy} provider={s.provider} onChange={(proxy) => update({ proxy })} />
        </Section>

        <Section title={tr.dictation}>
          <MicRow value={s.microphone} mics={mics} onChange={(microphone) => update({ microphone })} />
          <SwitchRow title={tr.behaviour.autoPaste} hint={tr.behaviour.autoPasteHint} value={s.autoPaste} onChange={(v) => update({ autoPaste: v })} />
          <SwitchRow title={tr.behaviour.restoreClipboard} hint={tr.behaviour.restoreClipboardHint} value={s.restoreClipboard} onChange={(v) => update({ restoreClipboard: v })} />
          {wakeAvailable && <SwitchRow title={tr.voice.wakeWord} hint={tr.voice.wakeWordHint} value={s.wakeWord} onChange={(v) => update({ wakeWord: v })} />}
          <SwitchRow title={tr.voice.stopPhrase} hint={tr.voice.stopPhraseHint} value={s.stopPhrase} onChange={(v) => update({ stopPhrase: v })} />
          <SwitchRow title={tr.behaviour.pauseMedia} hint={tr.behaviour.pauseMediaHint} value={s.pauseMedia} onChange={(v) => update({ pauseMedia: v })} />
          {/* A free service has no cost to show: the card shows none (src/main/dictation.ts). */}
          {pricePerMinute(models(s).live) > 0 && (
            <SwitchRow title={tr.behaviour.showCost} hint={tr.behaviour.showCostHint} value={s.showCost} onChange={(v) => update({ showCost: v })} />
          )}
          <SwitchRow title={tr.behaviour.sounds} hint={tr.behaviour.soundsHint} value={s.sounds} onChange={(v) => update({ sounds: v })} />
        </Section>

        <Section title={tr.keys.title}>
          <Row title={tr.keys.dictation} hint={tr.keys.dictationHint} below={<TriggerList value={s.triggers} onChange={(triggers) => update({ triggers })} />} />
          <SwitchRow title={tr.keys.tapHandsFree} hint={tr.keys.tapHandsFreeHint} value={s.tapHandsFree} onChange={(v) => update({ tapHandsFree: v })} />
          <SwitchRow title={tr.keys.escCancels} hint={tr.keys.escCancelsHint} value={s.escCancels} onChange={(v) => update({ escCancels: v })} />
          <Row title={tr.keys.pasteLast} hint={tr.keys.pasteLastHint} control={<AcceleratorRecorder value={s.pasteLastHotkey} onChange={(pasteLastHotkey) => update({ pasteLastHotkey })} />} />
        </Section>

        <Section title={tr.vocabulary}>
          <TermsRow s={s} update={update} />
          {/* OpenAI only, as on Android: the others take no context. */}
          {s.provider === "openai" && (
            <Row title={tr.recognition.context} hint={tr.recognition.contextHint}
              below={<textarea value={s.prompt} onChange={(e) => update({ prompt: e.target.value }, true)} rows={3} className={`${FIELD} scroll-thin w-full resize-none px-3 py-2 text-[13px] leading-5`} />}
            />
          )}
          <SwitchRow title={tr.behaviour.learn} hint={tr.behaviour.learnHint} value={s.learnCorrections} onChange={(v) => update({ learnCorrections: v })} />
        </Section>

        <SyncSection syncKeys={s.syncKeys} onSyncKeys={(syncKeys) => update({ syncKeys })} />

        <Section title={tr.t3.title}>
          <T3ModeRow value={s.t3Mode} onChange={(v) => update({ t3Mode: v })} />
          {s.t3Mode && canBringForward && <SwitchRow title={tr.t3.forward} hint={tr.t3.forwardHint} value={s.t3Forward} onChange={(v) => update({ t3Forward: v })} />}
          {s.t3Mode && canBringForward && <SwitchRow title={tr.t3.send} hint={tr.t3.sendHint} value={s.t3Send} onChange={(v) => update({ t3Send: v })} />}
          {s.t3Mode && (
            <Row title={tr.t3.prefix} hint={tr.t3.affixHint} control={<input value={s.t3Prefix} onChange={(e) => update({ t3Prefix: e.target.value }, true)} className={`${INPUT} w-56`} />} />
          )}
          {s.t3Mode && <Row title={tr.t3.suffix} control={<input value={s.t3Suffix} onChange={(e) => update({ t3Suffix: e.target.value }, true)} className={`${INPUT} w-56`} />} />}
        </Section>

        <Section title={tr.appearance.title}>
          <Row title={tr.appearance.language} hint={tr.appearance.languageHint} control={<Select label={tr.appearance.language} value={s.language} options={LANGUAGES} onChange={(language) => update({ language })} />} />
          <Row title={tr.appearance.theme} hint={tr.appearance.themeHint}
            control={<Select label={tr.appearance.theme} value={s.theme} options={THEMES.map((value) => ({ value, label: tr.appearance.themes[value] }))} onChange={(theme) => update({ theme })} />}
          />
          <SwitchRow title={tr.behaviour.pill} hint={tr.behaviour.pillHint} value={s.overlayPill} onChange={(v) => update({ overlayPill: v })} />
        </Section>

        <Section title={tr.about}>
          {updateState && <UpdateRow state={updateState} />}
          <SwitchRow title={tr.behaviour.openAtLogin} value={s.openAtLogin} onChange={(v) => update({ openAtLogin: v })} />
          <SwitchRow title={tr.behaviour.telemetry} hint={tr.behaviour.telemetryHint} value={s.telemetry} onChange={(v) => update({ telemetry: v })} />
        </Section>

        <Section title={tr.developer.title}>
          <SwitchRow title={tr.developer.formatText} hint={tr.developer.formatTextHint} value={s.paragraphs} onChange={(v) => update({ paragraphs: v })} />
          {/* Only OpenAI has a delay level. */}
          {s.provider === "openai" && <SwitchRow title={tr.developer.showDelay} hint={tr.developer.showDelayHint} value={s.showDelay} onChange={(v) => update({ showDelay: v })} />}
          {s.provider === "openai" && s.showDelay && (
            <Row title={tr.developer.delay} hint={tr.developer.delayHint} control={<Select label={tr.developer.delay} value={s.delay} options={DELAYS.map((d) => ({ value: d, label: d }))} onChange={(delay) => update({ delay })} />} />
          )}
        </Section>
      </div>
      <div
        aria-live="polite"
        className={`pointer-events-none fixed right-6 bottom-5 inline-flex items-center gap-1.5 rounded-lg border border-line bg-app px-3 py-1.5 text-[12.5px] text-ok shadow-sm transition-opacity duration-200 ${saved ? "opacity-100" : "opacity-0"}`}
      >
        <Check className="size-3.5" />
        {tr.saved}
      </div>
    </div>
  );
}

/**
 * The terms. A service that takes none (Nemotron, ChatGPT) says so, and the list, kept for the other
 * services and synced devices, opens on demand.
 */
function TermsRow({ s, update }: { s: Settings; update: Update }) {
  const tr = useStrings().settings.recognition;
  const note = { openai: "", gemini: tr.geminiNote, nemotron: tr.nemotronNote, chatgpt: tr.chatgptNote }[s.provider];
  const unused = s.provider === "nemotron" || s.provider === "chatgpt";
  const [open, setOpen] = useState(false);
  const field = (
    <textarea
      value={s.keywords.join("\n")}
      onChange={(e) => update({ keywords: e.target.value.split("\n") }, true)}
      className={`${FIELD} scroll-thin max-h-[210px] min-h-[78px] w-full resize-none px-3 py-2 text-[13px] leading-5 [field-sizing:content]`}
    />
  );
  if (!unused) return <Row title={tr.terms} hint={[tr.termsHint, note].filter(Boolean).join(" ")} below={field} />;
  return <Row title={tr.terms} hint={`${note} ${tr.otherServices}`} control={<Button onClick={() => setOpen(!open)}>{open ? tr.hide : tr.show}</Button>} below={open && field} />;
}

// ── Pieces, as in Android's Kit.kt ────────────────────────────────────────

const FIELD = "selectable rounded-lg border border-field-line bg-field text-fg outline-none placeholder:text-faint focus:border-fg/40 dark:placeholder:text-muted";
const INPUT = `${FIELD} h-8 px-3 text-[13px]`;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="px-4 pt-6 pb-3 text-[17px] font-semibold text-fg">{title}</h2>
      <Card>{children}</Card>
    </section>
  );
}

function Card({ children, warn }: { children: ReactNode; warn?: boolean }) {
  return <div className={`divide-y divide-divider overflow-hidden rounded-xl border bg-card ${warn ? "border-warn/45" : "border-line"}`}>{children}</div>;
}

/** A row: the title and a muted line on the left, the control on the right; [below] goes full width under them. */
function Row({ id, title, hint, control, below }: { id?: string; title: string; hint?: ReactNode; control?: ReactNode; below?: ReactNode }) {
  return (
    <div id={id} className="flex flex-col gap-2.5 px-4 py-3">
      <div className={`flex items-center gap-6 ${control ? "min-h-9" : ""}`}>
        <RowText title={title} hint={hint} />
        {control && <div className="ml-auto flex shrink-0 items-center gap-2">{control}</div>}
      </div>
      {below}
    </div>
  );
}

function RowText({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <span className="block max-w-[43rem] min-w-0 flex-1">
      <span className="block text-[14px] font-medium text-fg">{title}</span>
      {hint && <span className="mt-0.5 block text-[12.5px] leading-[1.45] text-pretty text-faint dark:text-muted">{hint}</span>}
    </span>
  );
}

/** The whole row toggles the switch; [below] goes under it, outside the toggle. */
function SwitchRow({ title, hint, value, onChange, below }: { title: string; hint?: string; value: boolean; onChange: (v: boolean) => void; below?: ReactNode }) {
  const row = (
    <button
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className="flex w-full items-center gap-6 px-4 py-3 text-left transition-colors hover:bg-tint/[0.02] focus-visible:bg-tint/[0.04] focus-visible:outline-none"
    >
      <span className="flex min-h-9 min-w-0 flex-1 items-center">
        <RowText title={title} hint={hint} />
      </span>
      <span className={`relative h-5 w-[34px] shrink-0 rounded-full transition-colors ${value ? "bg-accent-strong" : "bg-switch-off"}`}>
        <span className={`absolute top-0.5 left-0.5 size-4 rounded-full shadow-sm transition-transform ${value ? "translate-x-[14px] bg-thumb-on" : "bg-thumb"}`} />
      </span>
    </button>
  );
  if (!below) return row;
  return (
    <div>
      {row}
      <div className="-mt-1.5 px-4 pb-3">{below}</div>
    </div>
  );
}

/** T3 mode: one line on what it does; the whole story opens under "How it works". */
function T3ModeRow({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const tr = useStrings().settings.t3;
  const [open, setOpen] = useState(false);
  return (
    <SwitchRow
      title={tr.mode}
      hint={tr.modeShort}
      value={value}
      onChange={onChange}
      below={
        <>
          <button onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 text-[12.5px] text-accent-strong hover:underline">
            {tr.howItWorks}
            <ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
          {open && <p className="mt-1.5 max-w-[43rem] text-[12.5px] leading-[1.45] text-pretty text-faint dark:text-muted">{tr.modeHint}</p>}
        </>
      }
    />
  );
}

function Button({ primary, disabled, onClick, children }: { primary?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium whitespace-nowrap transition-colors disabled:opacity-40 ${
        primary ? "bg-accent-deep text-white hover:bg-accent-deep/90" : "border border-field-line text-fg hover:bg-tint/5 disabled:hover:bg-transparent"
      }`}
    >
      {children}
    </button>
  );
}

/** [label]: the row's title, read out by screen readers. */
function Select<T extends string>(props: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; className?: string }) {
  const { label, value, options, onChange, className = "" } = props;
  return (
    <span className={`relative inline-flex ${className}`}>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)} className={`${INPUT} w-full min-w-36 appearance-none truncate pr-8`}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-faint" />
    </span>
  );
}

/** A result line under a row: green when it worked, red when not, muted while in progress. */
function StatusText({ ok, children }: { ok?: boolean | null; children: ReactNode }) {
  return <span className={`text-[12.5px] ${ok === true ? "text-ok" : ok === false ? "text-error" : "text-faint"}`}>{children}</span>;
}

/** Scrolls to a row and lights it up for a moment, so the eye finds it. */
const scrollTo = (id: string) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.querySelector<HTMLElement>("input, button")?.focus({ preventScroll: true });
  el.classList.remove("row-flash");
  void el.offsetWidth; // restarts the animation on a second click
  el.classList.add("row-flash");
};

// ── Status ────────────────────────────────────────────────────────────────

/** All set, or what is missing before a dictation works; a click goes to the first such row. */
function StatusCard(props: { s: Settings; hasKey: boolean | undefined; failed: Failed; mics: string[] | null; accessibility: boolean | null }) {
  const strings = useStrings();
  const tr = strings.settings.status;
  const { s } = props;
  const signIn = PROVIDERS[s.provider].signIn;
  if (props.hasKey === undefined) return <div className="h-[66px]" />;
  const name = PROVIDERS[s.provider].name;
  const missing: { label: string; action: string; id: string }[] = [];
  if (!props.hasKey) missing.push(signIn ? { label: tr.signIn, action: tr.signInAction, id: "setting-key" } : { label: tr.apiKey(name), action: tr.apiKeyAction(name), id: "setting-key" });
  if (props.accessibility === false) missing.push({ label: tr.accessibility, action: tr.accessibilityAction, id: "setting-accessibility" });
  if (props.mics?.length === 0) missing.push({ label: tr.mic, action: tr.micAction, id: "setting-mic" });
  const key = s.triggers[0] ? triggerParts(s.triggers[0], strings.keyNames).join(" + ") : "";
  // One thing to do: the title says it. Several: listed under "Needs your attention".
  const [title, hint] = props.failed
    ? [signIn ? tr.signInFailed : tr.keyFailed(name), props.failed.reason]
    : missing.length === 1
      ? [missing[0]!.action, tr.untilThen]
      : missing.length
        ? [tr.problem, tr.left(missing.map((m) => m.label).join(", "))]
        : [tr.ready, tr.readyText(key, displayName(s.provider))];
  const ok = !missing.length && !props.failed;
  const target = props.failed ? "setting-key" : missing[0]?.id;
  const body = (
    <>
      <span className={`size-2 shrink-0 rounded-full ${ok ? "bg-ok" : props.failed ? "bg-error" : "bg-warn"}`} />
      <RowText title={title} hint={hint} />
      {target && <ChevronRight className="ml-auto size-4 shrink-0 text-faint" />}
    </>
  );
  return (
    <Card warn={!ok}>
      {target ? (
        <button onClick={() => scrollTo(target)} className="flex w-full items-center gap-3.5 px-4 py-3 text-left transition-colors hover:bg-tint/[0.02]">
          {body}
        </button>
      ) : (
        <div className="flex items-center gap-3.5 px-4 py-3">{body}</div>
      )}
    </Card>
  );
}

/** macOS only: whether the input helper has the Accessibility permission; null elsewhere. */
function useAccessibility(): boolean | null {
  const [granted, setGranted] = useState<boolean | null>(null);
  useEffect(() => {
    void ciao.settings.accessibility().then(setGranted);
    return ciao.settings.onAccessibility(setGranted);
  }, []);
  return granted;
}

// ── Recognition ───────────────────────────────────────────────────────────

/** Whether each provider has a key, kept up to date (one may come from another device). */
function useHasKeys(): Partial<Record<Provider, boolean>> {
  const [has, setHas] = useState<Partial<Record<Provider, boolean>>>({});
  useEffect(() => {
    let current = true;
    const check = () => {
      for (const provider of Object.keys(PROVIDERS) as Provider[])
        void ciao.settings.hasApiKey(provider).then((v) => current && setHas((h) => ({ ...h, [provider]: v })));
    };
    check();
    const off = ciao.settings.onKeys(check);
    return () => {
      current = false;
      off();
    };
  }, []);
  return has;
}

/** The transcription service: each with what it costs and whether it has a key, the models of the one in use. */
function ServiceRow({ s, hasKey, update }: { s: Settings; hasKey: Partial<Record<Provider, boolean>>; update: Update }) {
  const strings = useStrings().settings;
  const tr = strings.providers;
  const m = models(s);
  const options = (Object.keys(PROVIDERS) as Provider[]).map((provider) => {
    const perMinute = pricePerMinute(models({ ...s, provider }).live);
    const parts = [displayName(provider), perMinute ? tr.perHour(`$${(perMinute * 60).toFixed(2)}`) : tr.free];
    const has = hasKey[provider];
    if (provider !== s.provider && has !== undefined) parts.push(PROVIDERS[provider].signIn ? (has ? tr.signedIn : tr.signedOut) : has ? tr.hasKey : tr.noKey);
    return { value: provider, label: parts.join(" · ") };
  });
  return (
    <Row
      title={tr.service}
      hint={PROVIDERS[s.provider].signIn ? tr.introAccount : tr.intro}
      control={<Select label={tr.service} value={s.provider} options={options} onChange={(provider) => update({ provider })} className="w-[18rem]" />}
      below={<span className="-mt-1.5 text-[12.5px] text-faint dark:text-muted">{tr.models(m.live, m.file)}</span>}
    />
  );
}

/**
 * How many key checks each service has started. Only the latest one's answer counts, even when the
 * row that started an earlier one is gone (the service was switched away and back meanwhile).
 */
const checksStarted: Partial<Record<Provider, number>> = {};
const startCheck = (provider: Provider) => (checksStarted[provider] = (checksStarted[provider] ?? 0) + 1);
const isLatestCheck = (provider: Provider, n: number) => checksStarted[provider] === n;
const invalidateChecks = () => (Object.keys(PROVIDERS) as Provider[]).forEach(startCheck);

function ApiKeyRow({ provider, hasKey, onChecked }: { provider: Provider; hasKey: boolean; onChecked: (provider: Provider, reason: string | null) => void }) {
  const [value, setValue] = useState("");
  /** The last check's line and whether the key worked (null while checking); null before one. */
  const [check, setCheck] = useState<{ text: string; ok: boolean | null } | null>(null);
  const tr = useStrings().settings.apiKey;
  useEffect(() => {
    setValue("");
    setCheck(null);
  }, [provider]);
  // A key changed: the last check's line (or the one still running) is about the old one. Saving here
  // sends this before the save returns, so the check that follows a save isn't cleared.
  useEffect(() => ciao.settings.onKeys(() => setCheck(null)), []);
  const runCheck = async (key?: string) => {
    const n = startCheck(provider);
    setCheck({ text: tr.checking, ok: null });
    const r = await ciao.settings.checkKey(provider, key);
    if (!isLatestCheck(provider, n)) return; // a newer check (of a key saved meanwhile) is running
    setCheck(r.ok ? { text: tr.works(r.ms), ok: true } : { text: tr.failed(r.reason), ok: false });
    onChecked(provider, r.ok ? null : r.reason);
  };
  return (
    <Row
      id="setting-key"
      title={tr.title(PROVIDERS[provider].name)}
      hint={hasKey ? tr.saved : tr.missing}
      below={
        <>
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={value}
              placeholder={hasKey ? tr.replace : PROVIDERS[provider].keyPlaceholder}
              onChange={(e) => setValue(e.target.value)}
              className={`${INPUT} min-w-0 flex-1 font-mono placeholder:font-sans ${hasKey ? "" : "border-warn/45"}`}
            />
            {value.trim() ? (
              <Button
                primary
                onClick={async () => {
                  const key = value;
                  await ciao.settings.setApiKey(provider, key);
                  setValue("");
                  void runCheck(key);
                }}
              >
                {tr.save}
              </Button>
            ) : (
              hasKey && (
                <Button disabled={check?.ok === null} onClick={() => void runCheck()}>
                  {tr.check}
                </Button>
              )
            )}
          </div>
          {check && <StatusText ok={check.ok}>{check.text}</StatusText>}
        </>
      }
    />
  );
}

/** ChatGPT has no key to paste: the account signed in on chatgpt.com, in a window of Ciao's (src/main/chatgpt.ts). */
function ChatGPTAccountRow({ onChecked }: { onChecked: (provider: Provider, reason: string | null) => void }) {
  const [account, setAccount] = useState<{ email: string; expiresAt: number } | null | undefined>(undefined);
  /** A line about the last sign-in or check, under the account's own; null before one. */
  const [note, setNote] = useState<{ text: string; ok: boolean | null } | null>(null);
  const strings = useStrings().settings;
  const tr = strings.chatgpt;
  useEffect(() => {
    const load = () => void ciao.chatgpt.account().then(setAccount);
    load();
    return ciao.settings.onKeys(() => {
      setNote(null); // a check still running is about the old sign-in
      load();
    });
  }, []);
  const signIn = async () => {
    setNote({ text: tr.signingIn, ok: null });
    const ok = await ciao.chatgpt.signIn();
    setNote(ok ? null : { text: tr.notSignedIn, ok: false });
    if (ok) onChecked("chatgpt", null);
  };
  const check = async () => {
    const n = startCheck("chatgpt");
    setNote({ text: strings.apiKey.checking, ok: null });
    const r = await ciao.settings.checkKey("chatgpt");
    if (!isLatestCheck("chatgpt", n)) return;
    setNote(r.ok ? { text: strings.apiKey.works(r.ms), ok: true } : { text: strings.apiKey.failed(r.reason), ok: false });
    onChecked("chatgpt", r.ok ? null : r.reason);
  };
  if (account === undefined) return null;
  const days = account ? Math.max(0, Math.floor((account.expiresAt - Date.now()) / 86_400_000)) : 0;
  return (
    <Row
      id="setting-key"
      title={tr.label}
      hint={account ? tr.signedIn(account.email, days) : tr.signedOut}
      control={
        account ? (
          <>
            <Button disabled={note?.ok === null} onClick={() => void check()}>
              {strings.apiKey.check}
            </Button>
            <Button
              onClick={() => {
                setNote(null);
                onChecked("chatgpt", null);
                void ciao.chatgpt.signOut();
              }}
            >
              {tr.signOut}
            </Button>
          </>
        ) : (
          <Button primary onClick={() => void signIn()} disabled={note?.ok === null}>
            {tr.signIn}
          </Button>
        )
      }
      below={note && <StatusText ok={note.ok}>{note.text}</StatusText>}
    />
  );
}

/** The proxy: shown without its password; typed in anew to change it. */
function ProxyRow({ value, provider, onChange }: { value: string; provider: Provider; onChange: (proxy: string) => void }) {
  const [typed, setTyped] = useState("");
  const [open, setOpen] = useState(false);
  /** The last check of the proxy in use (its address), or null before one. */
  const [check, setCheck] = useState<{ href: string; text: string; ok: boolean | null } | null>(null);
  const strings = useStrings().settings;
  const tr = strings.providers;
  const current = parseProxy(value);
  const parsed = parseProxy(typed);
  const invalid = typed.trim() !== "" && !parsed;
  // Removed (here or by a sync): a check of an earlier proxy isn't shown if it comes back.
  useEffect(() => {
    if (!value) setCheck(null);
  }, [value]);

  const runCheck = async (proxy: ProxyAddress) => {
    setCheck({ href: proxy.href, text: tr.proxyChecking(proxyLabel(proxy)), ok: null });
    const r = await ciao.settings.checkProxy(proxy.href);
    const text = r.ok ? tr.proxyWorks(r.ms) : r.badLogin ? tr.proxyBadLogin : tr.proxyFailed(r.reason);
    setCheck((c) => (c?.href === proxy.href ? { href: proxy.href, text, ok: r.ok } : c));
  };

  const shown = check && check.href === current?.href ? check : null;
  // No proxy: just the row, the field opens on "Set up".
  if (!current && !open) return <Row title={tr.proxy} hint={tr.proxyHint(PROVIDERS[provider].name)} control={<Button onClick={() => setOpen(true)}>{tr.proxySetUp}</Button>} />;
  return (
    <Row
      title={tr.proxy}
      hint={tr.proxyHint(PROVIDERS[provider].name)}
      below={
        <>
          {current && <div className="text-[13px] text-fg">{tr.proxyVia(proxyLabel(current))}</div>}
          <div className="flex items-center gap-2">
            <input autoFocus={!current} value={typed} placeholder="http://user:password@host:port" onChange={(e) => setTyped(e.target.value)} className={`${INPUT} min-w-0 flex-1 font-mono`} />
            {typed.trim() && (
              <Button
                primary
                disabled={!parsed || parsed.href === current?.href}
                onClick={() => {
                  onChange(parsed!.href);
                  setTyped("");
                  void runCheck(parsed!);
                }}
              >
                {strings.apiKey.save}
              </Button>
            )}
            {current && <Button onClick={() => void runCheck(current)}>{tr.proxyCheck}</Button>}
            {current && (
              <Button
                onClick={() => {
                  onChange("");
                  setCheck(null);
                }}
              >
                {tr.proxyRemove}
              </Button>
            )}
          </div>
          {shown && <StatusText ok={shown.ok}>{shown.text}</StatusText>}
          {invalid && <StatusText ok={false}>{tr.proxyInvalid}</StatusText>}
        </>
      }
    />
  );
}

// ── Sync ──────────────────────────────────────────────────────────────────

/** Google sign-in for syncing terms and context between devices (src/main/sync.ts). */
function SyncSection({ syncKeys, onSyncKeys }: { syncKeys: boolean; onSyncKeys: (v: boolean) => void }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const strings = useStrings();
  const tr = strings.sync;
  useEffect(() => {
    void ciao.sync.get().then(setStatus);
    return ciao.sync.onStatus(setStatus);
  }, []);
  if (!status?.available) return null;
  const time = (ms: number) => new Date(ms).toLocaleTimeString(strings.locale, { hour: "2-digit", minute: "2-digit" });
  const hint =
    status.error ??
    (status.signingIn
      ? tr.signingIn
      : !status.email
        ? tr.signedOutHint
        : status.syncing || !status.syncedAt
          ? tr.syncing(status.email)
          : tr.syncedAt(status.email, time(status.syncedAt)));
  return (
    <Section title={tr.title}>
      <Row
        title={tr.account}
        hint={hint}
        control={
          <>
            {(status.syncing || status.signingIn) && <Loader2 className="size-4 animate-spin text-faint" />}
            {status.email || status.signingIn ? (
              <Button onClick={() => void ciao.sync.signOut()}>{status.signingIn ? tr.cancel : tr.signOut}</Button>
            ) : (
              <Button onClick={() => void ciao.sync.signIn()}>{tr.signIn}</Button>
            )}
          </>
        }
      />
      <SwitchRow title={tr.keys} hint={tr.keysHint} value={syncKeys} onChange={onSyncKeys} />
    </Section>
  );
}

// ── Microphone ────────────────────────────────────────────────────────────

/** The connected microphones, kept up to date; null until listed, so a saved one isn't called "not connected" meanwhile. */
function useMics(): string[] | null {
  const [mics, setMics] = useState<string[] | null>(null);
  useEffect(() => {
    let current = true;
    const load = async () => {
      let names = await listMics();
      // The names stay hidden until this page has opened a mic once: open one for a moment, then list again.
      if (!names.length) {
        try {
          (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop());
          names = await listMics();
        } catch {
          // no microphone, or no permission: the list stays empty
        }
      }
      if (current) setMics(names);
    };
    const reload = () => void load().catch((e) => console.warn("listing microphones:", errorText(e)));
    reload();
    navigator.mediaDevices.addEventListener("devicechange", reload);
    return () => {
      current = false;
      navigator.mediaDevices.removeEventListener("devicechange", reload);
    };
  }, []);
  return mics;
}

/** Which microphone dictation and the wake word record from, and a level bar to check it hears you. */
function MicRow({ value, mics, onChange }: { value: string; mics: string[] | null; onChange: (name: string) => void }) {
  const [testing, setTesting] = useState(false);
  /** While testing: the device actually heard (the default if the chosen one isn't connected), or why none is. */
  const [heard, setHeard] = useState<{ name: string } | { error: string } | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const tr = useStrings().settings.microphone;

  useEffect(() => {
    if (!testing) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let frame = 0;
    const timer = setTimeout(() => setTesting(false), 20_000);
    void (async () => {
      try {
        stream = await openMicStream(value);
      } catch (e) {
        if (!stopped) setHeard({ error: errorText(e) });
        return;
      }
      if (stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const track = stream.getAudioTracks()[0];
      const name = track ? await trackName(track).catch(() => track.label) : "";
      if (stopped) return; // the cleanup has stopped the stream
      setHeard({ name });
      ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const draw = () => {
        analyser.getFloatTimeDomainData(samples);
        let peak = 0;
        for (const v of samples) peak = Math.max(peak, Math.abs(v));
        // sqrt: speech peaks around 0.05–0.3, which a straight scale would show as a sliver.
        if (bar.current) bar.current.style.width = `${Math.min(100, Math.sqrt(peak) * 100)}%`;
        frame = requestAnimationFrame(draw);
      };
      draw();
    })();
    return () => {
      stopped = true;
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
      setHeard(null);
      if (bar.current) bar.current.style.width = "0";
    };
  }, [testing, value]);

  const options = [{ value: "", label: tr.systemDefault }, ...(mics ?? []).map((m) => ({ value: m, label: m }))];
  if (value && !mics?.includes(value)) options.push({ value, label: mics ? tr.notConnected(value) : value });
  const hint =
    !testing ? tr.deviceHint : !heard ? tr.testHint : "error" in heard ? tr.testFailed(heard.error) : heard.name ? `${tr.using(heard.name)}. ${tr.testHint}` : tr.testHint;
  return (
    <Row
      id="setting-mic"
      title={tr.device}
      hint={hint}
      control={
        <>
          <Select label={tr.device} value={value} options={options} onChange={onChange} className="w-52" />
          <button
            onClick={() => setTesting(!testing)}
            className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium transition-colors ${
              testing ? "border-accent-strong/50 bg-accent-strong/10 text-accent-strong" : "border-field-line text-fg hover:bg-tint/5"
            }`}
          >
            {testing ? <Square className="size-3" /> : <Mic className="size-3.5" />}
            {testing ? tr.stop : tr.test}
          </button>
        </>
      }
      below={
        testing && (
          <div className="h-1.5 overflow-hidden rounded-full bg-switch-off">
            <div ref={bar} className="h-full w-0 rounded-full bg-accent-strong transition-[width] duration-75" />
          </div>
        )
      }
    />
  );
}

// ── About ─────────────────────────────────────────────────────────────────

function updateHint(state: UpdateState, strings: Strings): string {
  const tr = strings.settings.updates;
  switch (state.phase) {
    case "disabled":
      return tr.disabled;
    case "idle":
      return tr.idle;
    case "checking":
      return tr.checking;
    case "latest":
      return tr.latest(new Date(state.checkedAt).toLocaleTimeString(strings.locale, { hour: "2-digit", minute: "2-digit" }));
    case "available":
      return tr.available(state.version);
    case "downloading":
      return tr.downloading(state.version, state.percent);
    case "installing":
      return tr.installing(state.version);
    case "error":
      return state.message;
  }
}

function UpdateRow({ state }: { state: UpdateState }) {
  const target = state.phase === "available" || state.phase === "downloading" || state.phase === "installing" || state.phase === "error" ? state.version : undefined;
  const busy = state.phase === "checking" || state.phase === "downloading" || state.phase === "installing";
  const strings = useStrings();
  const tr = strings.settings.updates;
  return (
    <Row
      title={tr.version(state.current)}
      hint={updateHint(state, strings)}
      control={
        <>
          {target && (
            <button onClick={() => void ciao.update.openNotes(target)} className="px-1 text-[13px] text-accent-strong underline-offset-2 hover:underline">
              {tr.whatsNew}
            </button>
          )}
          {busy && <Loader2 className="size-4 animate-spin text-faint" />}
          {state.phase === "available" || (state.phase === "error" && state.version) ? (
            <Button primary onClick={() => void ciao.update.install()}>
              {state.phase === "error" ? tr.retry : tr.update}
            </Button>
          ) : (
            state.phase !== "disabled" && (
              <Button disabled={busy} onClick={() => void ciao.update.check()}>
                {tr.check}
              </Button>
            )
          )}
        </>
      }
    />
  );
}

// ── Keys ──────────────────────────────────────────────────────────────────

/** A key or combination as chip text: "Alt + Shift + Z". */
function Caps({ parts }: { parts: string[] }) {
  return (
    <span className="inline-flex items-center gap-1 text-[13px] text-fg">
      {parts.map((k, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 && <span className="text-ghost">+</span>}
          {k}
        </span>
      ))}
    </span>
  );
}

/** A key as a value: filled, so it doesn't look like the outlined buttons next to it. */
const CHIP = "inline-flex h-8 items-center gap-1.5 rounded-lg border border-transparent bg-tint/[0.06]";

/** Dictation triggers; new ones are recorded by the native helper, so lone modifiers and mouse buttons work. */
function TriggerList({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [capturing, setCapturing] = useState(false);
  /** The last capture ended because the helper didn't hear a key this window did. */
  const [notHeard, setNotHeard] = useState(false);
  const tr = useStrings();
  // The helper swallows what it captures, so a key reaching this window means its hooks hear nothing
  // (they would have reported it at once): cancel and restart it. Esc here cancels whatever the helper does.
  useEffect(() => {
    if (!capturing) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.key === "Escape") return void ciao.settings.cancelCapture(false);
      if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return; // a lone modifier is captured on release
      timer ??= setTimeout(() => {
        setNotHeard(true);
        void ciao.settings.cancelCapture(true);
      }, 1000);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [capturing]);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {value.map((spec) => (
          <span key={spec} className={`${CHIP} pl-3 ${value.length > 1 ? "pr-1" : "pr-3"}`}>
            {isMouseTrigger(spec) && <MousePointerClick className="size-3.5 text-faint" />}
            <Caps parts={triggerParts(spec, tr.keyNames)} />
            {/* The last one stays: dictation needs a key. */}
            {value.length > 1 && (
              <button
                title={tr.settings.keys.remove}
                onClick={() => onChange(value.filter((v) => v !== spec))}
                className="rounded-md p-0.5 text-faint transition-colors hover:bg-tint/10 hover:text-fg dark:text-muted"
              >
                <X className="size-3.5" />
              </button>
            )}
          </span>
        ))}
        <button
          onClick={async () => {
            if (capturing) return void ciao.settings.cancelCapture(false);
            setNotHeard(false);
            setCapturing(true);
            const spec = await ciao.settings.captureTrigger();
            setCapturing(false);
            if (spec && !value.includes(spec)) onChange([...value, spec]);
          }}
          className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-colors ${
            capturing ? "border border-accent-strong/50 bg-accent-strong/10 text-accent-strong" : "border border-field-line text-fg hover:bg-tint/5"
          }`}
        >
          {capturing ? (
            <span className="animate-pulse">{tr.settings.keys.capturing}</span>
          ) : (
            <>
              <Plus className="size-3.5" />
              {tr.settings.keys.add}
            </>
          )}
        </button>
      </div>
      {notHeard && <div className="text-[12.5px] text-warn">{tr.settings.keys.notHeard}</div>}
    </div>
  );
}

/** Records an Electron accelerator from the next key combo pressed while focused. */
function AcceleratorRecorder({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [recording, setRecording] = useState(false);
  const tr = useStrings();
  return (
    <button
      onClick={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      onKeyDown={(e) => {
        if (!recording) return;
        e.preventDefault();
        if (e.key === "Escape") {
          setRecording(false);
          return;
        }
        const acc = acceleratorFromEvent(e);
        if (acc) {
          onChange(acc);
          setRecording(false);
        }
      }}
      className={`${CHIP} px-3 transition-colors ${recording ? "border-accent-strong/50 bg-accent-strong/10" : "hover:bg-tint/10"}`}
    >
      {recording ? <span className="animate-pulse text-[13px] text-accent-strong">{tr.settings.keys.recording}</span> : <Caps parts={acceleratorParts(value, tr.keyNames)} />}
    </button>
  );
}
