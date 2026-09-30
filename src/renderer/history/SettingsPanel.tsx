import { Check, KeyRound } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { DELAYS, type Settings } from "../../core/types";

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
        <div className="h-4 text-right text-[12px] text-emerald-400/80">{saved && <><Check className="mr-1 inline size-3.5" />сохранено</>}</div>

        <ApiKeyCard hasKey={hasKey} onSaved={() => setHasKey(true)} />

        <Card title="Распознавание">
          <Row label="Задержка" hint="Меньше — слова появляются раньше, больше — точнее.">
            <div className="flex rounded-xl bg-white/5 p-0.5">
              {DELAYS.map((d) => (
                <button
                  key={d}
                  onClick={() => update({ delay: d })}
                  className={`rounded-[10px] px-2.5 py-1 text-[12.5px] transition-colors ${s.delay === d ? "bg-white/15 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}`}
                >
                  {d}
                </button>
              ))}
            </div>
          </Row>
          <Row label="Языки" hint="Коды через запятую: ru, en">
            <input
              value={s.languages.join(", ")}
              onChange={(e) => update({ languages: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) }, true)}
              className="selectable w-48 rounded-lg bg-white/5 px-2.5 py-1.5 text-[13px] outline-none ring-1 ring-white/5 focus:ring-white/20"
            />
          </Row>
          <Field label="Контекст" hint="О чём ты обычно говоришь — модель подстраивается.">
            <textarea
              value={s.prompt}
              onChange={(e) => update({ prompt: e.target.value }, true)}
              rows={3}
              className="selectable w-full resize-none rounded-xl bg-white/5 px-3 py-2 text-[13px] leading-relaxed outline-none ring-1 ring-white/5 focus:ring-white/20"
            />
          </Field>
          <Field label="Термины" hint="Слова, которые надо писать точно так. По одному в строке.">
            <textarea
              value={s.keywords.join("\n")}
              onChange={(e) => update({ keywords: e.target.value.split("\n") }, true)}
              rows={6}
              className="selectable w-full rounded-xl bg-white/5 px-3 py-2 font-mono text-[12.5px] leading-relaxed outline-none ring-1 ring-white/5 focus:ring-white/20"
            />
          </Field>
        </Card>

        <Card title="Поведение">
          <Toggle label="Вставлять текст сразу" hint="Иначе он просто окажется в буфере обмена." value={s.autoPaste} onChange={(v) => update({ autoPaste: v })} />
          <Toggle label="Возвращать буфер обмена" hint="После вставки в буфере снова то, что было до диктовки." value={s.restoreClipboard} onChange={(v) => update({ restoreClipboard: v })} />
          <Toggle label="Показывать стоимость" hint="Сколько центов ты наговорил — прямо во время записи." value={s.showCost} onChange={(v) => update({ showCost: v })} />
          <Toggle label="Запускать вместе с Windows" value={s.openAtLogin} onChange={(v) => update({ openAtLogin: v })} />
        </Card>

        <Card title="Клавиши">
          <Keys label="Диктовка" keys={["Правый Ctrl"]} hint="Держи и говори. Короткое нажатие — режим без рук, ещё одно — готово." />
          <Keys label="Отмена" keys={["Esc"]} hint="Запись всё равно сохранится в истории." />
          <Keys label="Вставить последнее" keys={s.pasteLastHotkey.split("+")} />
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
          <KeyRound className={`size-4 ${hasKey ? "text-emerald-400" : "text-amber-300"}`} />
          <input
            type="password"
            value={value}
            placeholder={hasKey ? "заменить ключ…" : "sk-…"}
            onChange={(e) => setValue(e.target.value)}
            className="selectable w-56 rounded-lg bg-white/5 px-2.5 py-1.5 text-[13px] outline-none ring-1 ring-white/5 focus:ring-white/20"
          />
          <button
            disabled={!value.trim()}
            onClick={async () => {
              await ciao.settings.setApiKey(value);
              setValue("");
              onSaved();
            }}
            className="rounded-lg bg-white/10 px-3 py-1.5 text-[12.5px] text-zinc-100 transition-colors hover:bg-white/15 disabled:opacity-40"
          >
            Сохранить
          </button>
        </div>
      </Row>
    </Card>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl bg-white/[0.035] ring-1 ring-white/[0.06]">
      <h2 className="px-4 pt-3 pb-1 text-[12px] font-semibold tracking-wide text-zinc-500 uppercase">{title}</h2>
      <div className="divide-y divide-white/[0.05]">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div>
        <div className="text-[13.5px] text-zinc-200">{label}</div>
        {hint && <div className="text-[12px] text-zinc-500">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div>
        <div className="text-[13.5px] text-zinc-200">{label}</div>
        {hint && <div className="text-[12px] text-zinc-500">{hint}</div>}
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
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${value ? "bg-accent" : "bg-white/15"}`}
      >
        <span className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform ${value ? "translate-x-4" : ""}`} />
      </button>
    </Row>
  );
}

function Keys({ label, keys, hint }: { label: string; keys: string[]; hint?: string }) {
  return (
    <Row label={label} hint={hint}>
      <div className="flex gap-1">
        {keys.map((k) => (
          <kbd key={k} className="rounded-md bg-white/8 px-2 py-0.5 font-sans text-[12px] text-zinc-300 ring-1 ring-white/10">
            {k}
          </kbd>
        ))}
      </div>
    </Row>
  );
}
