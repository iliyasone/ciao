# Ciao: rules for agents

Ciao ships for Windows, macOS, Linux and Android. The three desktop platforms share one Electron
app; Android is a separate Kotlin app in `android/` that ports the parts it needs. Every change
must work on each platform it applies to, not only the one you develop on.

## Every feature works on every platform

- A user-facing change (a setting, a hotkey, a text, a dictation behaviour) lands on Windows,
  macOS and Linux in the same PR. If one platform can't have it yet, hide it there (as the
  wake-word toggle is hidden where `WakeWord.available()` is false) and say so in the README;
  never leave a control that silently does nothing.
- Platform-specific code stays in a few known places; keep everything else platform-neutral:
  - `native/win-input/` (C#), `native/mac-input/` (Swift) and `src/linux-input/` (Node): the
    input helpers. They speak one JSON-lines protocol, documented at the top of
    `native/win-input/Program.cs` (platform-only differences at the top of the other two) and
    driven by `src/main/input.ts`. A new command or event goes into **every** helper and that
    file.
  - `src/core/platform.ts` (`isMac`) for platform checks in `src/core/` and the renderers, which
    have no `process`; main-process code (`src/main/`) may use either.
  - `package.json` → `build.win` / `build.mac` / `build.linux` for packaging, and per-platform
    jobs in `.github/workflows/ci.yml` and `release.yml`.
- `src/core/` imports nothing from Electron or Node: it is meant to be reused by other shells
  (a T3 Code integration). Keep platform logic out of it beyond `isMac`.
- Android: a change to dictation behaviour (live layout, voice commands, the OpenAI calls) also
  goes into its Kotlin port in `android/`, or the PR says why Android doesn't need it. The ported
  files and their TypeScript originals are listed in the README's project layout; the unit tests
  in `android/` hold the TypeScript outputs, so change both together.
- User-facing text names no OS ("Start when you sign in", not "Start with Windows") unless it
  really differs; then branch on `isMac` in `src/core/i18n.ts`, in both languages. Key names:
  Windows `Ctrl`/`Alt`/`Win` are Control/Option/Command on macOS (`keyNames` in
  `src/core/i18n.ts`).
- New defaults must make sense on each platform (`src/main/settings.ts`: Mac keyboards have no
  Right Ctrl, so the default dictation key there is Right Option; Linux can't hide a middle click
  from other apps, so it isn't a default there).

## Checking a change

- `npm run typecheck` checks everything TypeScript; `cd android && ./gradlew testReleaseUnitTest`
  tests the Android app.
- CI builds every platform on every PR (`.github/workflows/ci.yml`): the Windows installer, the
  macOS disk images plus a smoke test (the input helper answers, the app is signed and starts),
  the Linux AppImage and `.deb` plus a smoke test (under headless weston with XWayland the app
  restarts on X11, starts, and its input helper answers), and the Android APK with its tests.
  The Windows and Linux jobs also check that the wake word (`build/kws`) is packaged. The macOS
  helper compiles only there or on a Mac. Nothing in CI presses keys, so the hooks and paste have
  to be tried on a real machine.
- The README documents behaviour per platform; update it in the same PR.
