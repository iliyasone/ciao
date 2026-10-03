# Ciao

**See what you say while you say it.**

Ciao is a dictation app that shows your words live, as you speak, in a small
floating card at the bottom of the screen. When you let go of the key, the text
is pasted into the app you were typing in.

Other dictation tools show nothing until you stop talking. You only find out that
"don't" became "do" after the text has landed in your prompt. With Ciao you watch
the transcript form in real time and catch the one word that flips the meaning
while you are still talking. It is built for talking to coding agents (T3 Code,
Claude Code, Codex) in Russian and English mixed with technical terms.

> Demo GIF: coming soon.

## Features

- **Live preview.** New words fade in bright and settle to grey. On a real
  microphone they appear about 0.8 s after they are spoken (median), and that holds
  steady over multi-minute dictations. The final text arrives about 0.6 s after you
  release the key.
  - This is at the default recognizer delay of `low`. The level ranges from
    `minimal` to `xhigh`: lower shows words sooner, higher is more accurate, and the
    price is the same. It is hidden by default. To see and change it, go to Settings
    (the app's UI is in Russian): *Настройки → Для разработчика → Показывать
    задержку*.
- **Push to talk.** Hold **Right Ctrl**, speak, release, and the text is pasted.
  - The **middle mouse button** works the same way by default: click to start
    hands-free, click again to finish, or hold it to talk.
  - Any key, key combo or mouse button (middle, side buttons) can be a trigger;
    see [Hotkeys](#hotkeys).
  - Or just say **"чао"** to start hands-free (*Настройки → Голосом*, off by default).
    The word is spotted on your computer, so nothing is sent anywhere until you
    dictate: [Vosk](https://alphacephei.com/vosk/) hears it within ~0.2 s and
    [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) keyword spotting double-checks
    the last second of audio, which filters near words like "чаю" or "чекаут".
    It costs about 10% of one CPU core and ~280 MB of memory, adds ~170 MB to the app,
    and the mic stays open while it is on.
  - Tapping for less than 0.35 s switches to hands-free mode: tap again to finish,
    or say **"чао-чао"** (the words themselves are not pasted; toggle in
    *Настройки → Голосом*).
  - **Esc** cancels. Nothing is transcribed or pasted, but the recording stays in
    the history.
- **The card stays out of your way.**
  - Moving the pointer over it makes it see-through, so you can read what's
    underneath; scroll it and it turns solid again.
  - Drag the grip at its bottom edge to move it, and the corner to change its
    width. Double-click the grip to put it back at the bottom centre.
- **Pastes where you started.** The text goes into the window that was active when
  you pressed the key. If you switched away, nothing is typed anywhere and the text
  is left on the clipboard. After a successful paste, the clipboard is restored.
- **Paste the last transcript again** with **Alt+Shift+Z**.
- **Nothing is lost.**
  - Audio is written to disk while you speak.
  - If the live connection drops, recording continues and the saved file is
    transcribed when you stop.
  - If that fails too (for example, you are still offline), nothing is pasted. The
    dictation is marked "not transcribed" in the history, where you can transcribe
    it later.
  - A dictation interrupted by a crash or restart is transcribed from its saved
    audio on the next start and shown on screen with a *Copy* button.
- **History.** Click the tray icon to see every dictation. You can play it, copy
  it, delete it, or transcribe it again:
  - **More accurate** re-runs the whole file through `gpt-transcribe`.
  - **Live** re-runs it through the streaming model.
- **Paragraphs and lists, live.** The card lays the text out while you speak, and
  the pasted text has the same layout:
  - a long pause (1.2 s) before a new sentence starts a paragraph;
  - a sentence starting with "первое", "во-вторых", "третий момент"… starts a
    numbered item (the word itself is dropped); inside a list "и ещё", "дальше",
    "также" do too, and only a longer pause (2 s) ends the list.
  - These are fixed rules, no model, so it costs no time. Toggle in
    *Настройки → Поведение → Абзацы и списки*.
- **Context** (Settings tab). Describe what you usually talk about and list the
  terms that must be spelled exactly (`T3 Code`, `WebSocket`, …). This noticeably
  improves product names and identifiers.
- **Light, dark or system theme** (*Настройки → Оформление*). System is the
  default and follows Windows live.
- **Cost meter.** Shows how many cents the current dictation costs. You can turn
  it off in Settings.

## Requirements

- Windows 10/11 (x64). macOS, Linux and Android are not supported yet.
- An OpenAI API key with access to `gpt-live-transcribe` and `gpt-transcribe`.

Pricing is per minute of audio: live transcription is $0.017/min (about $1 per
hour of talking), re-transcribing a file with `gpt-transcribe` is $0.0045/min.
Idle time costs nothing.

## Install

Download `Ciao-Setup-<version>.exe` from the
[latest release](https://github.com/iliyasone/ciao/releases/latest) and run it. It
installs for your user only (no admin prompt) into `%LOCALAPPDATA%\Programs\Ciao`
and starts Ciao. If you already run a copy you built yourself, quit it first
(tray → *Выход*); otherwise the new one hands over to it and exits.

1. The installer is unsigned, so SmartScreen may warn you: choose *More info → Run
   anyway*.
2. Ciao lives in the system tray. On first start the Settings tab opens: paste
   your API key there.
3. If nothing is recorded, allow microphone access for desktop apps. It is in
   Windows Settings → Privacy & security → Microphone.

Ciao starts with Windows by default. The toggle is in Settings.

### Updates

Ciao checks GitHub Releases for a newer version 15 s after it starts and every
4 hours after that. When there is one, an **Обновить до X** button shows in the
window's title bar and in the tray menu. Click it: the new version downloads,
Ciao quits, installs it silently and starts again. Settings, the key and the
history in `%APPDATA%\Ciao` stay. Nothing is downloaded until you click, and a
failed check in the background shows nothing.

To check by hand, go to *Настройки → Обновления → Проверить*.

A portable copy (the `release/win-unpacked` folder from `npm run dist:win`) is
updated the same way. The update installs Ciao into `%LOCALAPPDATA%\Programs\Ciao`,
and from then on that copy runs and starts with Windows. You can delete the old
folder. A dev run (`electron .`) never updates.

### Build it yourself

You need Node.js 22+ and the .NET 8 SDK. The build runs on Windows, Linux or macOS
and always produces the Windows app.

```sh
git clone https://github.com/iliyasone/ciao.git
cd ciao
npm install
npm run build:native        # the input helper → build/win-input/Ciao.Input.exe
npm run build:kws           # the wake-word detector and model (~50 MB) → build/kws
npm run dist:win            # a portable folder → release/win-unpacked/Ciao.exe
npm run dist:win:installer  # the installer → release/Ciao-Setup-<version>.exe
```

`dist:win` needs nothing else. `dist:win:installer` needs Wine on Linux and macOS
(NSIS uses it for the uninstaller). On Windows it needs nothing extra.

### API key

Ciao takes the key from the `OPENAI_API_KEY` environment variable. If that is not
set, it reads `%APPDATA%\Ciao\openai-key.txt`. Saving a key in Settings writes
that file.

### Hotkeys

Set them in *Настройки → Клавиши*.

- **Dictation triggers.** Click *Добавить* and press what you want: a key (Right
  Ctrl on its own works), a combo such as Ctrl+Alt+Space, or a mouse button
  (middle, side buttons, optionally with modifiers). You can have several.
- **What other apps see.**
  - Keys and mouse buttons bound this way are hidden from other apps.
  - A lone modifier such as Right Ctrl is the exception, so Ctrl+C keeps working.
- **Paste last.** Click the shortcut and press a new combo.

In `%APPDATA%\Ciao\config.json` these are:

- `triggers` — `+`-separated modifiers (`Ctrl`, `Alt`, `Shift`, `Win`), then a
  [.NET `Keys`](https://learn.microsoft.com/dotnet/api/system.windows.forms.keys)
  name or `MButton` / `XButton1` / `XButton2`.
- `pasteLastHotkey` — an
  [Electron accelerator](https://www.electronjs.org/docs/latest/api/accelerator).

## Where things are stored

Everything is under `%APPDATA%\Ciao`:

- `config.json` — settings. Most of them are edited in the app.
- `openai-key.txt` — the API key.
- `history\<id>\` — one folder per dictation, holding `audio.wav` and
  `entry.json` (transcripts, timings, cost, where it was pasted). The `<id>`
  starts with the UTC start time, `YYYYMMDD-HHMMSS`. The **Folder** button in the
  history window opens it.
- `ciao.log` — the app log.

Recordings and transcripts stay on your machine. Audio leaves it only to be
transcribed by OpenAI.

## Development

### Releasing

Run `npm version 0.3.0 && git push --follow-tags` on `main`. `npm version` bumps
`package.json`, commits and tags `v0.3.0`; pushing the tag starts the release.

[`release.yml`](.github/workflows/release.yml) builds the installer on a Windows
runner and uploads it to a draft GitHub release with `latest.yml`, which is the
file installed copies check. The draft is published once all files are uploaded.
The tag must equal `v` + the `package.json` version, or the workflow fails.
[`ci.yml`](.github/workflows/ci.yml) builds the same installer on every PR and
attaches it to the run as an artifact.

### Testing without speaking

While Ciao is running, run `Ciao.exe --replay=C:\path\to\clip.wav`. The clip plays
through the live pipeline in real time: it shows in the card and is saved to the
history, but nothing is pasted. Make a compatible clip with:

```sh
ffmpeg -i input.m4a -ar 24000 -ac 1 -sample_fmt s16 clip.wav
```

### How it works

```
mic ─► AudioWorklet (24 kHz PCM16, 40 ms chunks)            overlay renderer
          │
          ▼
       main process ──► history/<id>/audio.wav              written first, always
          │
          └──► OpenAI Realtime, gpt-live-transcribe (WebSocket, opened in advance)
                  │ transcript deltas ──► overlay card (live text)
                  │ on key release: commit ──► final transcript
                  ▼
       Ciao.Input.exe ──► Ctrl+V into the window that was active at the start
```

- A WebSocket session is kept open in reserve, because opening one takes up to a
  second and speech would otherwise start streaming late. An idle session costs
  nothing.
- If the final transcript does not arrive, the saved WAV is sent to
  `gpt-transcribe` instead.
- `Ciao.Input.exe` is a tiny .NET helper. It installs a low-level keyboard hook,
  so it can see Right Ctrl being held and swallow Esc (the focused app never
  receives it). It also reports the foreground window and injects Ctrl+V. It
  talks to the Electron app over stdin/stdout, one JSON object per line.

### Project layout

- `src/core/` — platform-neutral TypeScript with no Electron or Node imports: the
  Realtime transcription session, PCM/WAV helpers, prices and shared types. It is
  meant to be reused as-is by other shells (a T3 Code integration, mobile).
- `src/main/` — the Electron main process:
  - `dictation.ts` — the hotkey state machine and the pipeline;
  - `history.ts` — storage and crash recovery;
  - `transcribe.ts` — live and file transcription;
  - `paste.ts` — clipboard-preserving paste;
  - `updater.ts` — updates from GitHub Releases.
- `src/renderer/` — React 19 + Tailwind 4:
  - `overlay/` — the live card and microphone capture;
  - `history/` — the history and settings window.
- `src/preload/` — the IPC bridge exposed to the renderer as `window.ciao`.
- `native/win-input/` — the Windows keyboard and paste helper (C#).

`npm run typecheck` checks the whole project.

## Roadmap

- Built-in dictation and read-aloud in [T3 Code](https://github.com/pingdotgg/t3code).
  The stack is the same (Electron, React, Tailwind, Vite), so the UI and the core
  can move into it.
- Android and macOS.

## License

MIT
