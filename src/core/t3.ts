// T3 mode (Settings → T3 Code): dictation for the T3 Code app's chat box. T3 Code tells other apps
// nothing about which chat is open (its window title is always the app's name), so the text goes in
// by pasting into the T3 Code window in front, and only there.

/** The T3 Code app, by its process ("T3 Code (Nightly)" on Windows and macOS, "t3code" on Linux) or its window title. */
export function isT3Code(w: { process: string; title: string }): boolean {
  return /^t3[ -]?code\b/i.test(w.process.replace(/\.exe$/i, "")) || /^T3 Code\b/.test(w.title);
}

/** The prompt as pasted: the user's words between the optional prefix and suffix (say, "Клауди," to get a spoken answer). */
export function t3Prompt(text: string, prefix: string, suffix: string): string {
  return [prefix.trim(), text, suffix.trim()].filter(Boolean).join(" ");
}

/** Whether `text` shows up in the field's text, whatever the field did to spaces and line breaks. */
export function fieldHas(field: string, text: string): boolean {
  const squash = (s: string) => s.replace(/\s+/g, "");
  const want = squash(text);
  return want.length > 0 && squash(field).includes(want.slice(-80));
}
