import { Check, KeyRound, Monitor, Moon, MousePointerClick, Plus, Sun, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { acceleratorFromEvent, acceleratorParts, isMouseTrigger, triggerParts } from "../../core/triggers";
import { DELAYS, type Settings, type Theme } from "../../core/types";

const THEMES: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "Системная", icon: Monitor },
  { value: "light", label: "Светлая", icon: Sun },
  { value: "dark", label: "Тёмная", icon: Moon },
];

export function SettingsPanel() {
  const [s, setS] = useState<Settings | null>(null);
  const [hasKey, setHasKey] = useState(true);
  const [saved, setSaved] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

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
        <div className="h-4 text-right text-[12px] text-emerald-700 dark:text-emerald-400/80">{saved && <><Check className="mr-1 inline size-3.5" />сохранено</>}</div>

        <ApiKeyCard hasKey={hasKey} onSaved={() => setHasKey(true)} />

        <Card title="Распознавание">
          <Row label="Языки" hint="Коды через запятую: ru, en">
            <input
              value={s.languages.join(", ")}
              onChange={(e) => update({ languages: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) }, true)}
              className="selectable w-48 rounded-lg bg-tint/5 px-2.5 py-1.5 text-[13px] outline-none ring-1 ring-tint/5 focus:ring-tint/20"
            />
          </Row>
          <Field label="Контекст" hint="О чём ты обычно говоришь — модель подстраивается.">
            <textarea
              value={s.prompt}
              onChange={(e) => update({ prompt: e.target.value }, true)}
              rows={3}
              className="selectable w-full resize-none rounded-xl bg-tint/5 px-3 py-2 text-[13px] leading-relaxed outline-none ring-1 ring-tint/5 focus:ring-tint/20"
            />
          </Field>
          <Field label="Термины" hint="Слова, которые надо писать точно так. По одному в строке.">
            <textarea
              value={s.keywords.join("\n")}
              onChange={(e) => update({ keywords: e.target.value.split("\n") }, true)}
              rows={6}
              className="selectable w-full rounded-xl bg-tint/5 px-3 py-2 font-mono text-[12.5px] leading-relaxed outline-none ring-1 ring-tint/5 focus:ring-tint/20"
            />
          </Field>
        </Card>

        <Card title="Оформление">
          <Row label="Тема" hint="Системная — как в Windows, переключается вместе с ней.">
            <Segmented value={s.theme} options={THEMES} onChange={(theme) => update({ theme })} />
          </Row>
        </Card>

        <Card title="Поведение">
          <Toggle
            label="Абзацы и списки"
            hint="Пауза перед новым предложением — новый абзац, «первое… второе…» — нумерованный список. Видно сразу, пока говоришь."
            value={s.formatText}
            onChange={(v) => update({ formatText: v })}
          />
          <Toggle label="Вставлять текст сразу" hint="Иначе он просто окажется в буфере обмена." value={s.autoPaste} onChange={(v) => update({ autoPaste: v })} />
          <Toggle label="Возвращать буфер обмена" hint="После вставки в буфере снова то, что было до диктовки." value={s.restoreClipboard} onChange={(v) => update({ restoreClipboard: v })} />
          <Toggle label="Показывать стоимость" hint="Сколько центов ты наговорил — прямо во время записи." value={s.showCost} onChange={(v) => update({ showCost: v })} />
          <Toggle label="Запускать вместе с Windows" value={s.openAtLogin} onChange={(v) => update({ openAtLogin: v })} />
        </Card>

        <Card title="Голосом">
          <Toggle
            label="Включать словом «чао»"
            hint="Скажи «чао» — начнётся запись без рук. Микрофон слушает постоянно, но слово ищется прямо на компьютере: пока ты не диктуешь, звук никуда не уходит. Windows покажет значок микрофона."
            value={s.wakeWord}
            onChange={(v) => update({ wakeWord: v })}
          />
          <Toggle
            label="Заканчивать словами «чао-чао»"
            hint="В режиме без рук скажи «чао-чао» в конце — запись закончится, а сами слова не вставятся."
            value={s.stopPhrase}
            onChange={(v) => update({ stopPhrase: v })}
          />
        </Card>

        <Card title="Клавиши">
          <Field
            label="Диктовка"
            hint="Держи и говори. Короткое нажатие — режим без рук, ещё одно — готово. Назначенные кнопки мыши другие приложения не получают."
          >
            <TriggerList value={s.triggers} onChange={(triggers) => update({ triggers })} />
          </Field>
          <Keys label="Отмена" keys={["Esc"]} hint="Запись всё равно сохранится в истории." />
          <Row label="Вставить последнее" hint="Нажми, чтобы задать другое сочетание.">
            <AcceleratorRecorder value={s.pasteLastHotkey} onChange={(pasteLastHotkey) => update({ pasteLastHotkey })} />
          </Row>
        </Card>

        <Card title="Для разработчика">
          <Toggle
            label="Показывать задержку"
            hint="Уровень задержки распознавания — в окошке записи, здесь и в меню трея."
            value={s.showDelay}
            onChange={(v) => update({ showDelay: v })}
          />
          {s.showDelay && (
            <Row label="Задержка" hint="Меньше — слова появляются раньше, больше — точнее. На цену не влияет.">
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
  return (
    <Card title="OpenAI">
      <Row label="API-ключ" hint={hasKey ? "Ключ сохранён локально." : "Без ключа ничего не распознается."}>
        <div className="flex items-center gap-2">
          <KeyRound className={`size-4 ${hasKey ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-300"}`} />
          <input
            type="password"
            value={value}
            placeholder={hasKey ? "заменить ключ…" : "sk-…"}
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
            Сохранить
          </button>
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
  return (
    <div className="flex flex-wrap items-center gap-2">
      {value.map((spec) => (
        <span key={spec} className="inline-flex items-center gap-1.5 rounded-xl bg-tint/5 py-1 pr-1 pl-2 ring-1 ring-tint/[0.07]">
          {isMouseTrigger(spec) && <MousePointerClick className="size-3.5 text-faint" />}
          <Caps parts={triggerParts(spec)} />
          <button
            title="Убрать"
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
          <span className="animate-pulse">Нажми клавишу, сочетание или кнопку мыши… Esc — отмена</span>
        ) : (
          <>
            <Plus className="size-3.5" />
            Добавить
          </>
        )}
      </button>
    </div>
  );
}

/** Records an Electron accelerator from the next key combo pressed while focused. */
function AcceleratorRecorder({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [recording, setRecording] = useState(false);
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
      {recording ? <span className="animate-pulse px-1 text-[12.5px] text-accent">Нажми сочетание… Esc — отмена</span> : <Caps parts={acceleratorParts(value)} />}
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
