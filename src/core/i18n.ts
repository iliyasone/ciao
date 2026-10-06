// Every user-facing string, in Russian and English. Developer logs stay in English and out of here.
// The main process keeps the current language here (setLang); renderers subscribe through
// src/renderer/lang.ts so a change in Settings applies without a restart.

import { isMac } from "./platform";
import type { Lang } from "./types";

const PASTE = isMac ? "⌘V" : "Ctrl+V";

const ru = {
  /** For toLocaleDateString / toLocaleTimeString. */
  locale: "ru-RU",

  tray: {
    tooltip: "Ciao — диктовка с живым превью",
    updateTo: (v: string) => `Обновить до ${v}`,
    updating: (v: string, percent: number) => `Обновление ${v}: ${percent}%`,
    installing: (v: string) => `Устанавливается ${v}…`,
    retryUpdate: (v: string) => `Повторить обновление до ${v}`,
    historyAndSettings: "История и настройки",
    pasteLast: (hotkey: string) => `Вставить последнее  (${hotkey})`,
    delay: (d: string) => `Задержка: ${d}`,
    showCost: "Показывать стоимость",
    quit: "Выход",
  },

  linuxInput: {
    title: "Ciao не слышит клавиатуру",
    message:
      "Чтобы Ciao замечал клавишу диктовки, добавь себя в группу input и перезайди в систему:\n\nsudo usermod -aG input $USER\n\nПока этого нет, диктовку можно начать словом «чао» (Настройки → Голосом).",
    copy: "Скопировать команду",
    ok: "Понятно",
  },

  errors: {
    noApiKey: "Нет API-ключа",
    noApiKeyHint: (who: string) => `Нет API-ключа ${who} — вставь его в Настройках`,
    entryNotFound: "Запись не найдена",
    cannotReach: (who: string) => `Не удалось связаться с ${who}`,
    connectionClosed: (reason: string) => `Соединение закрыто${reason ? `: ${reason}` : ""}`,
    providerError: (who: string) => `Ошибка ${who}`,
    timeout: (who: string) => `${who} не ответил вовремя`,
    status: (who: string, status: number | string) => `${who} ответил ${status}`,
    microphone: (message: string) => `Микрофон: ${message}`,
    noFinalText: "Нет финального текста",
    fileFailed: (reason: string, message: string) => `${reason}; файл: ${message}`,
    closedMidTranscription: "Приложение закрылось до конца распознавания — аудио сохранено, можно распознать заново",
  },

  overlay: {
    cancelled: "Отменено — запись в истории",
    clipboard: `Окно сменилось — текст в буфере, ${PASTE}`,
    noPermission: "Нет Универсального доступа — текст в буфере. Включи его: Настройки → Доступ",
    saved: "Не распозналось — аудио сохранено в истории",
    recovered: "Запись прервалась при перезапуске — вот что ты сказал",
    recoveredSaved: "Запись прервалась при перезапуске — аудио сохранено в истории",
    close: "Закрыть",
    copy: "Скопировать",
    copied: "Скопировано",
    history: "История",
    gripTitle: "Перетащи, чтобы подвинуть. Двойной клик — вернуть на место.",
    resizeTitle: "Потяни, чтобы изменить ширину",
  },

  update: {
    noReleases: "На GitHub пока нет опубликованных версий",
    incompleteRelease: `Последний релиз на GitHub собран не до конца — в нём нет ${isMac ? "latest-mac.yml" : "latest.yml"}`,
    offline: "Нет интернета",
    githubStatus: (status: string) => `GitHub ответил ${status} — попробуй позже`,
    buttonTitle: (current: string) =>
      isMac ? `Сейчас ${current}. Откроется страница загрузки.` : `Сейчас ${current}. Скачается и перезапустится само.`,
    retryUpdate: "Повторить обновление",
    updateTo: (v: string) => `Обновить до ${v}`,
    downloading: (v: string, percent: number) => `Скачивается ${v}: ${percent}%`,
    restarting: "Перезапуск…",
  },

  tabs: { history: "История", settings: "Настройки" },

  history: {
    today: "Сегодня",
    yesterday: "Вчера",
    statToday: "сегодня",
    statTotal: "всего",
    minutes: (n: number) => `${n} мин`,
    search: "Поиск по тексту",
    nothingFound: "Ничего не нашлось",
    empty: `Пока пусто. Зажми ${isMac ? "правый Option" : "правый Ctrl"} и скажи что-нибудь.`,
    source: { live: "вживую", "retry-live": "повтор вживую", "retry-file": "целиком", formatted: "с абзацами" },
    status: {
      running: "идёт",
      failed: "не распознано",
      cancelled: "отменено",
      pasted: "вставлено",
      clipboard: "в буфере",
    },
    noText: "Текста нет — можно распознать запись заново.",
    copy: "Копировать",
    copied: "Скопировано",
    retryFile: "Точнее",
    retryFileTitle: "Распознать всю запись заново файловой моделью",
    retryLive: "Вживую",
    retryLiveTitle: "Прогнать запись через live-модель ещё раз",
    openFolder: "Открыть папку записи",
    delete: "Удалить запись и аудио",
    confirmDelete: "Точно удалить?",
    play: "Слушать",
    pause: "Пауза",
  },

  settings: {
    saved: "сохранено",
    apiKey: {
      label: "API-ключ",
      saved: "Ключ сохранён локально.",
      missing: "Без ключа ничего не распознается.",
      replace: "заменить ключ…",
      save: "Сохранить",
    },
    recognition: {
      title: "Распознавание",
      provider: "Сервис",
      providerHint: (live: string, file: string) => `Вживую — ${live}, «Точнее» — ${file}.`,
      smart: "Понимать поправки",
      smartHint:
        "Убирает «э-э», оговорки и повторы, а поправки применяет: «в два, нет, в три» — будет «в три». Только в готовом тексте: пока говоришь, видно всё как есть.",
      languages: "Языки",
      languagesHint: "Коды через запятую: ru, en",
      context: "Контекст",
      contextHint: "О чём ты обычно говоришь — модель подстраивается.",
      terms: "Термины",
      termsHint: "Слова, которые надо писать точно так. По одному в строке.",
      geminiNote: "Gemini сам определяет язык и не берёт контекст — только термины.",
    },
    appearance: {
      title: "Оформление",
      language: "Язык",
      languageHint: "Язык интерфейса.",
      theme: "Тема",
      themeHint: "Системная — как в системе, переключается вместе с ней.",
      themes: { system: "Системная", light: "Светлая", dark: "Тёмная" },
    },
    behaviour: {
      title: "Поведение",
      formatText: "Абзацы и списки",
      formatTextHint: "Пауза перед новым предложением — новый абзац, «первое… второе…» — нумерованный список. Видно сразу, пока говоришь.",
      autoPaste: "Вставлять текст сразу",
      autoPasteHint: "Иначе он просто окажется в буфере обмена.",
      restoreClipboard: "Возвращать буфер обмена",
      restoreClipboardHint: "После вставки в буфере снова то, что было до диктовки.",
      showCost: "Показывать стоимость",
      showCostHint: "Сколько центов ты наговорил — прямо во время записи.",
      openAtLogin: "Запускать при входе в систему",
      telemetry: "Анонимная статистика",
      telemetryHint:
        "Сколько людей пользуется Ciao и как работает диктовка: чем запущена, сколько длилась и стоила, в какое приложение вставлялась и удалось ли, версия системы — со случайным id установки. Ни текст, ни звук, ни названия окон не отправляются.",
    },
    voice: {
      title: "Голосом",
      wakeWord: "Включать словом «чао»",
      wakeWordHint:
        "Скажи «чао» — начнётся запись без рук. Микрофон слушает постоянно, но слово ищется прямо на компьютере: пока ты не диктуешь, звук никуда не уходит. Система покажет, что микрофон занят.",
      stopPhrase: "Заканчивать словами «чао-чао»",
      stopPhraseHint: "В режиме без рук скажи «чао-чао» в конце — запись закончится, а сами слова не вставятся.",
    },
    keys: {
      title: "Клавиши",
      dictation: "Диктовка",
      dictationHint: "Держи и говори. Короткое нажатие — режим без рук, ещё одно — готово. Назначенные кнопки мыши другие приложения не получают.",
      cancel: "Отмена",
      cancelHint: "Запись всё равно сохранится в истории.",
      pasteLast: "Вставить последнее",
      pasteLastHint: "Нажми, чтобы задать другое сочетание.",
      remove: "Убрать",
      add: "Добавить",
      capturing: "Нажми клавишу, сочетание или кнопку мыши… Esc — отмена",
      recording: "Нажми сочетание… Esc — отмена",
    },
    updates: {
      title: "Обновления",
      version: (v: string) => `Версия ${v}`,
      disabled: "Это запуск из исходников — обновляй через git.",
      idle: "Новые версии проверяются сами, раз в несколько часов.",
      checking: "Проверяю…",
      latest: (time: string) => `Это последняя версия. Проверено в ${time}.`,
      available: (v: string) =>
        isMac
          ? `Вышла ${v}. Закрой Ciao (значок в строке меню → Выход), скачай новую и перетащи в «Программы» вместо старой.`
          : `Вышла ${v}. Скачается и перезапустится само; идущая диктовка не потеряется.`,
      downloading: (v: string, percent: number) => `Скачивается ${v}: ${percent}%`,
      installing: (v: string) => `Устанавливается ${v}, Ciao сейчас перезапустится…`,
      whatsNew: "Что нового",
      retry: "Повторить",
      update: "Обновить",
      check: "Проверить",
    },
    developer: {
      title: "Для разработчика",
      showDelay: "Показывать задержку",
      showDelayHint: "Уровень задержки распознавания — в окошке записи, здесь и в меню трея.",
      delay: "Задержка",
      delayHint: "Меньше — слова появляются раньше, больше — точнее. На цену не влияет.",
    },
    permissions: {
      title: "Доступ",
      accessibility: "Универсальный доступ",
      accessibilityHint:
        "Без него Ciao не слышит клавишу диктовки и не может вставить текст. Включи Ciao в Системных настройках → Конфиденциальность и безопасность → Универсальный доступ. Если он там уже включён (например, после обновления), убери его кнопкой «−», нажми эту кнопку ещё раз и включи Ciao снова.",
      granted: "Разрешено",
      open: "Открыть настройки",
    },
  },

  sync: {
    title: "Синхронизация",
    account: "Аккаунт Google",
    signedOutHint:
      "Войди, чтобы термины, контекст и API-ключи были одни на всех твоих устройствах, включая телефон. Они хранятся в скрытой папке Ciao на твоём Google Диске; другие файлы на Диске Ciao не видит.",
    keys: "Синхронизировать API-ключи",
    keysHint:
      "Так удобнее: на новом устройстве достаточно войти, ключ вставлять не нужно. Ключи лежат в скрытой папке Ciao на твоём Google Диске, так что их прочитает любой, кто сможет войти в твой аккаунт Google. Выключи, и каждый ключ останется только на своём устройстве: Ciao уберёт их с Диска.",
    syncedAt: (email: string, time: string) => `${email} · синхронизировано в ${time}`,
    syncing: (email: string) => `${email} · синхронизирую…`,
    signingIn: "Продолжи в браузере…",
    signIn: "Войти через Google",
    signOut: "Выйти",
    cancel: "Отмена",
    signInFailed: (message: string) => `Не удалось войти: ${message}`,
    failed: (message: string) => `Не удалось синхронизировать: ${message}`,
    signedOut: "Google больше не даёт Ciao доступ — войди снова",
    newerFormat: "Файл синхронизации записан более новой версией Ciao — обнови приложение",
    timedOut: "вход не завершился за 5 минут",
    noDrive: "нет доступа к Диску. Войди ещё раз и отметь на странице Google галочку про данные конфигурации на Google Диске",
    browserDone: "Можно вернуться в Ciao и закрыть эту вкладку.",
  },

  /** Key and mouse-button names (see core/triggers.ts); keys missing here are shown as they are. On a Mac,
   * Alt and Win in trigger names are Option and Command (see native/mac-input). */
  keyNames: {
    RControlKey: "Правый Ctrl",
    LControlKey: "Левый Ctrl",
    RMenu: "Правый Alt",
    LMenu: "Левый Alt",
    RShiftKey: "Правый Shift",
    LShiftKey: "Левый Shift",
    RWin: "Правый Win",
    MButton: "Колёсико мыши",
    XButton1: "Боковая кнопка «назад»",
    XButton2: "Боковая кнопка «вперёд»",
    Space: "Пробел",
    Apps: "Меню",
    ...(isMac && {
      RControlKey: "Правый Control",
      LControlKey: "Левый Control",
      RMenu: "Правый Option",
      LMenu: "Левый Option",
      RWin: "Правый Command",
      LWin: "Левый Command",
      Ctrl: "Control",
      Alt: "Option",
      Win: "Command",
      Super: "Command",
      Back: "Delete",
      Delete: "Удаление вперёд",
    }),
  } as Record<string, string>,
};

export type Strings = typeof ru;

const en: Strings = {
  locale: "en-US",

  tray: {
    tooltip: "Ciao — dictation with a live preview",
    updateTo: (v) => `Update to ${v}`,
    updating: (v, percent) => `Updating to ${v}: ${percent}%`,
    installing: (v) => `Installing ${v}…`,
    retryUpdate: (v) => `Retry update to ${v}`,
    historyAndSettings: "History and settings",
    pasteLast: (hotkey) => `Paste last  (${hotkey})`,
    delay: (d) => `Delay: ${d}`,
    showCost: "Show cost",
    quit: "Quit",
  },

  linuxInput: {
    title: "Ciao can't hear the keyboard",
    message:
      "For Ciao to notice the dictation key, add yourself to the input group and sign in again:\n\nsudo usermod -aG input $USER\n\nUntil then you can start a dictation by saying “ciao” (Settings → Voice).",
    copy: "Copy the command",
    ok: "OK",
  },

  errors: {
    noApiKey: "No API key",
    noApiKeyHint: (who) => `No ${who} API key — paste it in Settings`,
    entryNotFound: "Recording not found",
    cannotReach: (who) => `Couldn't reach ${who}`,
    connectionClosed: (reason) => `Connection closed${reason ? `: ${reason}` : ""}`,
    providerError: (who) => `${who} error`,
    timeout: (who) => `${who} didn't respond in time`,
    status: (who, status) => `${who} responded with ${status}`,
    microphone: (message) => `Microphone: ${message}`,
    noFinalText: "No final text",
    fileFailed: (reason, message) => `${reason}; file: ${message}`,
    closedMidTranscription: "The app closed before transcription finished — the audio is saved, you can transcribe it again",
  },

  overlay: {
    cancelled: "Cancelled — the recording is in history",
    clipboard: `The window changed — the text is on the clipboard, press ${PASTE} to paste`,
    noPermission: "No Accessibility permission — the text is on the clipboard. Turn it on: Settings → Permissions",
    saved: "Couldn't transcribe — the audio is saved in history",
    recovered: "The recording was cut short by a restart — here's what you said",
    recoveredSaved: "The recording was cut short by a restart — the audio is saved in history",
    close: "Close",
    copy: "Copy",
    copied: "Copied",
    history: "History",
    gripTitle: "Drag to move. Double-click to put it back.",
    resizeTitle: "Drag to change the width",
  },

  update: {
    noReleases: "No versions have been published on GitHub yet",
    incompleteRelease: `The latest release on GitHub is incomplete — it has no ${isMac ? "latest-mac.yml" : "latest.yml"}`,
    offline: "No internet connection",
    githubStatus: (status) => `GitHub responded with ${status} — try again later`,
    buttonTitle: (current) =>
      isMac ? `You have ${current}. Opens the download page.` : `You have ${current}. Ciao downloads the update and restarts on its own.`,
    retryUpdate: "Retry update",
    updateTo: (v) => `Update to ${v}`,
    downloading: (v, percent) => `Downloading ${v}: ${percent}%`,
    restarting: "Restarting…",
  },

  tabs: { history: "History", settings: "Settings" },

  history: {
    today: "Today",
    yesterday: "Yesterday",
    statToday: "today",
    statTotal: "total",
    minutes: (n) => `${n} min`,
    search: "Search text",
    nothingFound: "Nothing found",
    empty: `Nothing here yet. Hold ${isMac ? "Right Option" : "Right Ctrl"} and say something.`,
    source: { live: "live", "retry-live": "live again", "retry-file": "whole recording", formatted: "with paragraphs" },
    status: {
      running: "in progress",
      failed: "not transcribed",
      cancelled: "cancelled",
      pasted: "pasted",
      clipboard: "on clipboard",
    },
    noText: "No text — you can transcribe the recording again.",
    copy: "Copy",
    copied: "Copied",
    retryFile: "More accurate",
    retryFileTitle: "Transcribe the whole recording again with the file model",
    retryLive: "Live",
    retryLiveTitle: "Run the recording through the live model again",
    openFolder: "Open the recording's folder",
    delete: "Delete the recording and its audio",
    confirmDelete: "Really delete?",
    play: "Listen",
    pause: "Pause",
  },

  settings: {
    saved: "saved",
    apiKey: {
      label: "API key",
      saved: "The key is stored locally.",
      missing: "Nothing gets transcribed without a key.",
      replace: "replace key…",
      save: "Save",
    },
    recognition: {
      title: "Recognition",
      provider: "Service",
      providerHint: (live, file) => `Live: ${live}; "More accurate": ${file}.`,
      smart: "Apply spoken corrections",
      smartHint:
        "Drops \"um\", false starts and repeats, and applies corrections: \"at 2, no, at 3\" becomes \"at 3\". In the final text only: while you speak you see everything as said.",
      languages: "Languages",
      languagesHint: "Comma-separated codes: ru, en",
      context: "Context",
      contextHint: "What you usually talk about — the model adapts to it.",
      terms: "Terms",
      termsHint: "Words to spell exactly as written. One per line.",
      geminiNote: "Gemini detects the language itself and takes no context, only the terms.",
    },
    appearance: {
      title: "Appearance",
      language: "Language",
      languageHint: "The language of the interface.",
      theme: "Theme",
      themeHint: "System follows the OS and switches along with it.",
      themes: { system: "System", light: "Light", dark: "Dark" },
    },
    behaviour: {
      title: "Behavior",
      formatText: "Paragraphs and lists",
      formatTextHint: "A pause before a new sentence starts a paragraph; “first… second…” becomes a numbered list. You see it as you speak.",
      autoPaste: "Paste text right away",
      autoPasteHint: "Otherwise it just lands on the clipboard.",
      restoreClipboard: "Restore the clipboard",
      restoreClipboardHint: "After pasting, the clipboard holds what it had before the dictation.",
      showCost: "Show cost",
      showCostHint: "What the dictation costs in cents, shown while you record.",
      openAtLogin: "Start when you sign in",
      telemetry: "Anonymous usage stats",
      telemetryHint:
        "How many people use Ciao and how dictation goes: what started it, how long it took and what it cost, which kind of app it pasted into and whether that worked, the OS version — with a random install id. No text, audio or window titles are sent.",
    },
    voice: {
      title: "Voice",
      wakeWord: "Start with the word “ciao”",
      wakeWordHint:
        "Say “ciao” to start a hands-free recording. The microphone listens all the time, but the word is detected right on your computer: until you dictate, no audio leaves it. The system will show that the microphone is in use.",
      stopPhrase: "Finish with “ciao ciao”",
      stopPhraseHint: "In hands-free mode, say “ciao ciao” at the end — the recording stops, and the words themselves aren't pasted.",
    },
    keys: {
      title: "Keys",
      dictation: "Dictation",
      dictationHint: "Hold and speak. A short press starts hands-free mode, another one finishes. Other apps don't receive the mouse buttons assigned here.",
      cancel: "Cancel",
      cancelHint: "The recording is still saved in history.",
      pasteLast: "Paste last",
      pasteLastHint: "Click to set a different shortcut.",
      remove: "Remove",
      add: "Add",
      capturing: "Press a key, a combination or a mouse button… Esc to cancel",
      recording: "Press a shortcut… Esc to cancel",
    },
    updates: {
      title: "Updates",
      version: (v) => `Version ${v}`,
      disabled: "Running from source — update with git.",
      idle: "New versions are checked for automatically, every few hours.",
      checking: "Checking…",
      latest: (time) => `This is the latest version. Checked at ${time}.`,
      available: (v) =>
        isMac
          ? `${v} is out. Quit Ciao (menu bar icon → Quit), download the new one and drag it into Applications over the old one.`
          : `${v} is out. Ciao downloads it and restarts on its own; a dictation in progress won't be lost.`,
      downloading: (v, percent) => `Downloading ${v}: ${percent}%`,
      installing: (v) => `Installing ${v}, Ciao will restart now…`,
      whatsNew: "What's new",
      retry: "Retry",
      update: "Update",
      check: "Check",
    },
    developer: {
      title: "For developers",
      showDelay: "Show delay",
      showDelayHint: "The recognition delay level — in the recording card, here and in the tray menu.",
      delay: "Delay",
      delayHint: "Lower means words appear sooner, higher means more accurate. Doesn't affect the price.",
    },
    permissions: {
      title: "Permissions",
      accessibility: "Accessibility",
      accessibilityHint:
        "Without it Ciao can't hear the dictation key or paste the text. Turn Ciao on in System Settings → Privacy & Security → Accessibility. If it is already on there (after an update, say), remove it with −, press this button again and turn Ciao on.",
      granted: "Granted",
      open: "Open settings",
    },
  },

  sync: {
    title: "Sync",
    account: "Google account",
    signedOutHint:
      "Sign in to use the same terms, context and API keys on all your devices, the phone included. They're kept in a hidden Ciao folder in your Google Drive; Ciao can't see any other file there.",
    keys: "Sync API keys",
    keysHint:
      "Easier: on a new device you just sign in, no key to paste. The keys sit in the hidden Ciao folder in your Google Drive, so anyone who can sign in to your Google account can read them. Turn this off to keep each key on its own device only: Ciao removes them from Drive.",
    syncedAt: (email, time) => `${email} · synced at ${time}`,
    syncing: (email) => `${email} · syncing…`,
    signingIn: "Continue in the browser…",
    signIn: "Sign in with Google",
    signOut: "Sign out",
    cancel: "Cancel",
    signInFailed: (message) => `Couldn't sign in: ${message}`,
    failed: (message) => `Couldn't sync: ${message}`,
    signedOut: "Google no longer gives Ciao access — sign in again",
    newerFormat: "The sync file was written by a newer Ciao — update the app",
    timedOut: "the sign-in didn't finish within 5 minutes",
    noDrive: "no access to Drive. Sign in again and tick the box about configuration data in your Google Drive on Google's page",
    browserDone: "You can go back to Ciao and close this tab.",
  },

  keyNames: {
    RControlKey: "Right Ctrl",
    LControlKey: "Left Ctrl",
    RMenu: "Right Alt",
    LMenu: "Left Alt",
    RShiftKey: "Right Shift",
    LShiftKey: "Left Shift",
    RWin: "Right Win",
    MButton: "Middle mouse button",
    XButton1: "Back side button",
    XButton2: "Forward side button",
    Space: "Space",
    Apps: "Menu",
    ...(isMac && {
      RControlKey: "Right Control",
      LControlKey: "Left Control",
      RMenu: "Right Option",
      LMenu: "Left Option",
      RWin: "Right Command",
      LWin: "Left Command",
      Ctrl: "Control",
      Alt: "Option",
      Win: "Command",
      Super: "Command",
      Back: "Delete",
      Delete: "Forward Delete",
    }),
  },
};

export const STRINGS: Record<Lang, Strings> = { ru, en };

/** The language for an OS locale: Russian for Russian, English for everything else. */
export const langFromLocale = (locale: string | undefined): Lang => (/^ru\b/i.test(locale ?? "") ? "ru" : "en");

let current: Lang = "en";

/** The main process's language; renderers keep their own (src/renderer/lang.ts). */
export function setLang(lang: Lang): void {
  current = lang;
}

export const t = (): Strings => STRINGS[current];
