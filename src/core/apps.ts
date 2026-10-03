// Which app a dictation went to, as a coarse label for anonymous usage counts.
// Only apps on this closed list are named; everything else is "other", so a rare or in-house
// program never leaves the machine. Keys are Windows process names, lower-case, without ".exe".

const APPS: Record<string, string> = {
  // Coding agents and editors
  "t3 code": "t3code",
  "t3 code (nightly)": "t3code",
  claude: "claude",
  codex: "codex",
  chatgpt: "chatgpt",
  code: "vscode",
  "code - insiders": "vscode",
  cursor: "cursor",
  windsurf: "windsurf",
  zed: "zed",
  devenv: "visualstudio",
  idea64: "jetbrains",
  pycharm64: "jetbrains",
  webstorm64: "jetbrains",
  rider64: "jetbrains",
  clion64: "jetbrains",
  goland64: "jetbrains",
  datagrip64: "jetbrains",
  // Terminals
  windowsterminal: "terminal",
  cmd: "terminal",
  powershell: "terminal",
  pwsh: "terminal",
  conhost: "terminal",
  "wezterm-gui": "terminal",
  alacritty: "terminal",
  mintty: "terminal",
  // Browsers
  chrome: "browser",
  msedge: "browser",
  firefox: "browser",
  brave: "browser",
  opera: "browser",
  vivaldi: "browser",
  arc: "browser",
  browser: "browser", // Yandex Browser
  // Messengers and calls
  telegram: "telegram",
  ayugram: "telegram",
  slack: "slack",
  discord: "discord",
  whatsapp: "whatsapp",
  "ms-teams": "teams",
  teams: "teams",
  zoom: "zoom",
  // Documents and notes
  winword: "word",
  excel: "excel",
  powerpnt: "powerpoint",
  outlook: "outlook",
  olk: "outlook",
  onenote: "onenote",
  notion: "notion",
  obsidian: "obsidian",
  notepad: "notepad",
  "notepad++": "notepad",
  explorer: "explorer",
};

/** "WindowsTerminal" → "terminal", "Code" → "vscode", an unlisted program → "other". */
export function appLabel(process: string): string {
  return APPS[process.trim().toLowerCase().replace(/\.exe$/, "")] ?? "other";
}
