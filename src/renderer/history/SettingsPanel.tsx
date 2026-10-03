import { ArrowDownToLine, Check, KeyRound, Loader2, Monitor, Moon, MousePointerClick, Plus, RefreshCw, Sun, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { acceleratorFromEvent, acceleratorParts, isMouseTrigger, triggerParts } from "../../core/triggers";
import type { Strings } from "../../core/i18n";
import { DELAYS, type Lang, type Settings, type Theme, type UpdateState } from "../../core/types";
import { useStrings } from "../lang";

const THEMES: { value: Theme; icon: typeof Sun }[] = [
  { value: "system", icon: Monitor },
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
];

// Each language is named in itself, so it can be found whatever the current one is.
const LANGUAGES: { value: Lang; label: string }[] = [
  { value: "ru", label: "Русский" },
  { value: "en", label: "English" },
];

export function SettingsPanel({ updateState }: { updateState: UpdateState | null }) {
  const [s, setS] = useState<Settings | null>(null);
  const [hasKey, setHasKey] = useState(true);
  const [saved, setSaved] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const tr = useStrings().settings;

  useEffect(() => {
    void ciao.settings.get().then(setS);
    void ciao.settings.hasApiKey().then(setHasKey);
  }, []);

  const update = (patch: Partial<Settings>, debounce = false) => {
    setS((prev) => {
      const next = { ...prev!, ...patch };
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(
        async () => {
          await ciao.settings.set(next);
          setSaved(true);
          setTimeout(() => setSaved(false), 1200);
        },
        debounce ? 500 : 0,
      );
      return next;
    });
  };

  if (!s) return null;

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-4 px-6 pt-5 pb-16">
        <div className="h-4 text-right text-[12px] text-emerald-700 dark:text-emerald-400/80">{saved && <><Check className="mr-1 inline size-3.5" />{tr.saved}</>}</div>

        <ApiKeyCard hasKey={hasKey} onSaved={() => setHasKey(true)} />

        <Card title={tr.recognition.title}>
          <Row label={tr.recognition.languages} hint={tr.recognition.languagesHint}>
            <input
              value={s.languages.join(", ")}
              onChange={(e) => update({ languages: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) }, true)}
              className="selectable w-48 rounded-lg bg-tint/5 px-2.5 py-1.5 text-[13px] outline-none ring-1 ring-tint/5 focus:ring-tint/20"
            />
          </Row>
          <Field label={tr.recognition.context} hint={tr.recognition.contextHint}>
            <textarea
              value={s.prompt}
              onChange={(e) => update({ prompt: e.target.value }, true)}
              rows={3}
              className="selectable w-full resize-none rounded-xl bg-tint/5 px-3 py-2 text-[13px] leading-relaxed outline-none ring-1 ring-tint/5 focus:ring-tint/20"
            />
          </Field>
          <Field label={tr.recognition.terms} hint={tr.recognition.termsHint}>
            <textarea
              value={s.keywords.join("\n")}
              onChange={(e) => update({ keywords: e.target.value.split("\n") }, true)}
              rows={6}
              className="selectable w-full rounded-xl bg-tint/5 px-3 py-2 font-mono text-[12.5px] leading-relaxed outline-none ring-1 ring-tint/5 focus:ring-tint/20"
            />
          </Field>
        </Card>

        <Card title={tr.appearance.title}>
          <Row label={tr.appearance.language} hint={tr.appearance.languageHint}>
            <Segmented value={s.language} options={LANGUAGES} onChange={(language) => update({ language })} />
          </Row>
          <Row label={tr.appearance.theme} hint={tr.appearance.themeHint}>
            <Segmented value={s.theme} options={THEMES.map((o) => ({ ...o, label: tr.appearance.themes[o.value] }))} onChange={(theme) => update({ theme })} />
          </Row>
        </Card>

        <Card title={tr.behaviour.title}>
          <Toggle
            label={tr.behaviour.formatText}
            hint={tr.behaviour.formatTextHint}
            value={s.formatText}
            onChange={(v) => update({ formatText: v })}
          />
          <Toggle label={tr.behaviour.autoPaste} hint={tr.behaviour.autoPasteHint} value={s.autoPaste} onChange={(v) => update({ autoPaste: v })} />
          <Toggle label={tr.behaviour.restoreClipboard} hint={tr.behaviour.restoreClipboardHint} value={s.restoreClipboard} onChange={(v) => update({ restoreClipboard: v })} />
          <Toggle label={tr.behaviour.showCost} hint={tr.behaviour.showCostHint} value={s.showCost} onChange={(v) => update({ showCost: v })} />
          <Toggle label={tr.behaviour.openAtLogin} value={s.openAtLogin} onChange={(v) => update({ openAtLogin: v })} />
        </Card>

        <Card title={tr.voice.title}>
          <Toggle
            label={tr.voice.wakeWord}
            hint={tr.voice.wakeWordHint}
            value={s.wakeWord}
            onChange={(v) => update({ wakeWord: v })}
          />
          <Toggle
            label={tr.voice.stopPhrase}
            hint={tr.voice.stopPhraseHint}
            value={s.stopPhrase}
            onChange={(v) => update({ stopPhrase: v })}
          />
        </Card>

        <Card title={tr.keys.title}>
          <Field label={tr.keys.dictation} hint={tr.keys.dictationHint}>
            <TriggerList value={s.triggers} onChange={(triggers) => update({ triggers })} />
          </Field>
          <Keys label={tr.keys.cancel} keys={["Esc"]} hint={tr.keys.cancelHint} />
          <Row label={tr.keys.pasteLast} hint={tr.keys.pasteLastHint}>
            <AcceleratorRecorder value={s.pasteLastHotkey} onChange={(pasteLastHotkey) => update({ pasteLastHotkey })} />
          </Row>
        </Card>

        {updateState && <UpdateCard state={updateState} />}

        <Card title={tr.developer.title}>
          <Toggle
            label={tr.developer.showDelay}
            hint={tr.developer.showDelayHint}
            value={s.showDelay}
            onChange={(v) => update({ showDelay: v })}
          />
          {s.showDelay && (
            <Row label={tr.developer.delay} hint={tr.developer.delayHint}>
              <Segmented value={s.delay} options={DELAYS.map((d) => ({ value: d, label: d }))} onChange={(delay) => update({ delay })} />
            </Row>
          )}
        </Card>
      </div>
    </div>
  );
}

function ApiKeyCard({ hasKey, onSaved }: { hasKey: boolean; onSaved: () => void }) {
  const [value, setValue] = useState("");
  const tr = useStrings().settings.apiKey;
  return (
    <Card title="OpenAI">
      <Row label={tr.label} hint={hasKey ? tr.saved : tr.missing}>
        <div className="flex items-center gap-2">
          <KeyRound className={`size-4 ${hasKey ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-300"}`} />
          <input
            type="password"
            value={value}
            placeholder={hasKey ? tr.replace : "sk-…"}
            onChange={(e) => setValue(e.target.value)}
            className="selectable w-56 rounded-lg bg-tint/5 px-2.5 py-1.5 text-[13px] outline-none ring-1 ring-tint/5 focus:ring-tint/20"
          />
          <button
            disabled={!value.trim()}
            onClick={async () => {
              await ciao.settings.setApiKey(value);
              setValue("");
              onSaved();
            }}
            className="rounded-lg bg-tint/10 px-3 py-1.5 text-[12.5px] text-fg transition-colors hover:bg-tint/15 disabled:opacity-40"
          >
            {tr.save}
          </button>
        </div>
      </Row>
    </Card>
  );
}

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

function UpdateCard({ state }: { state: UpdateState }) {
  const target = state.phase === "available" || state.phase === "downloading" || state.phase === "installing" || state.phase === "error" ? state.version : undefined;
  const busy = state.phase === "checking" || state.phase === "downloading" || state.phase === "installing";
  const button = "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] transition-colors disabled:opacity-40";
  const strings = useStrings();
  const tr = strings.settings.updates;
  return (
    <Card title={tr.title}>
      <Row label={tr.version(state.current)} hint={updateHint(state, strings)}>
        <div className="flex shrink-0 items-center gap-2">
          {target && (
            <button onClick={() => void ciao.update.openNotes(target)} className="text-[12.5px] text-muted underline-offset-2 hover:text-fg hover:underline">
              {tr.whatsNew}
            </button>
          )}
          {busy && <Loader2 className="size-4 animate-spin text-faint" />}
          {state.phase === "available" || (state.phase === "error" && state.version) ? (
            <button onClick={() => void ciao.update.install()} className={`${button} bg-accent text-white hover:bg-accent/90`}>
              <ArrowDownToLine className="size-3.5" />
              {state.phase === "error" ? tr.retry : tr.update}
            </button>
          ) : (
            state.phase !== "disabled" && (
              <button disabled={busy} onClick={() => void ciao.update.check()} className={`${button} bg-tint/10 text-fg hover:bg-tint/15`}>
                <RefreshCw className="size-3.5" />
                {tr.check}
              </button>
            )
          )}
        </div>
      </Row>
    </Card>
  );
}

function Segmented<T extends string>(props: {
  value: T;
  options: { value: T; label: string; icon?: typeof Sun }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex shrink-0 rounded-xl bg-tint/5 p-0.5">
      {props.options.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          onClick={() => props.onChange(value)}
          className={`inline-flex items-center gap-1.5 rounded-[10px] px-2.5 py-1 text-[12.5px] transition-colors ${
            props.value === value ? "bg-card text-fg shadow-sm ring-1 ring-tint/10 dark:bg-tint/15 dark:ring-0" : "text-muted hover:text-fg"
          }`}
        >
          {Icon && <Icon className="size-3.5" />}
          {label}
        </button>
      ))}
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl bg-card ring-1 ring-tint/[0.07]">
      <h2 className="px-4 pt-3 pb-1 text-[12px] font-semibold tracking-wide text-faint uppercase">{title}</h2>
      <div className="divide-y divide-tint/[0.06]">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div>
        <div className="text-[13.5px] text-fg">{label}</div>
        {hint && <div className="text-[12px] text-faint">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div>
        <div className="text-[13.5px] text-fg">{label}</div>
        {hint && <div className="text-[12px] text-faint">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Toggle({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Row label={label} hint={hint}>
      <button
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${value ? "bg-accent" : "bg-tint/15"}`}
      >
        <span className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform ${value ? "translate-x-4" : ""}`} />
      </button>
    </Row>
  );
}

function Caps({ parts }: { parts: string[] }) {
  return (
    <span className="inline-flex items-center gap-1">
      {parts.map((k, i) => (
        <kbd key={i} className="rounded-md bg-tint/8 px-2 py-0.5 font-sans text-[12px] text-fg2 ring-1 ring-tint/10">
          {k}
        </kbd>
      ))}
    </span>
  );
}

/** Dictation triggers; new ones are recorded by the native helper, so lone modifiers and mouse buttons work. */
function TriggerList({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [capturing, setCapturing] = useState(false);
  const tr = useStrings();
  return (
    <div className="flex flex-wrap items-center gap-2">
      {value.map((spec) => (
        <span key={spec} className="inline-flex items-center gap-1.5 rounded-xl bg-tint/5 py-1 pr-1 pl-2 ring-1 ring-tint/[0.07]">
          {isMouseTrigger(spec) && <MousePointerClick className="size-3.5 text-faint" />}
          <Caps parts={triggerParts(spec, tr.keyNames)} />
          <button
            title={tr.settings.keys.remove}
            disabled={value.length === 1}
            onClick={() => onChange(value.filter((v) => v !== spec))}
            className="rounded-md p-0.5 text-faint transition-colors hover:bg-tint/10 hover:text-fg disabled:opacity-30"
          >
            <X className="size-3.5" />
          </button>
        </span>
      ))}
      <button
        disabled={capturing}
        onClick={async () => {
          setCapturing(true);
          const spec = await ciao.settings.captureTrigger();
          setCapturing(false);
          if (spec && !value.includes(spec)) onChange([...value, spec]);
        }}
        className={`inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[12.5px] transition-colors ${
          capturing ? "bg-accent/15 text-accent ring-1 ring-accent/40" : "text-muted ring-1 ring-tint/10 hover:bg-tint/5 hover:text-fg"
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
      className={`rounded-xl px-1.5 py-1 transition-colors ${recording ? "bg-accent/15 ring-1 ring-accent/40" : "hover:bg-tint/5"}`}
    >
      {recording ? <span className="animate-pulse px-1 text-[12.5px] text-accent">{tr.settings.keys.recording}</span> : <Caps parts={acceleratorParts(value, tr.keyNames)} />}
    </button>
  );
}

function Keys({ label, keys, hint }: { label: string; keys: string[]; hint?: string }) {
  return (
    <Row label={label} hint={hint}>
      <div className="flex gap-1">
        {keys.map((k) => (
          <kbd key={k} className="rounded-md bg-tint/8 px-2 py-0.5 font-sans text-[12px] text-fg2 ring-1 ring-tint/10">
            {k}
          </kbd>
        ))}
      </div>
    </Row>
  );
}
