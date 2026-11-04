// Production contracts, not recorded Mac hardware output or cfg(test) snapshot spellings.
// Cargo.lock pins Crossterm 0.29.0 at the fork revision below.
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/Cargo.lock#L5971-L5973
// https://github.com/openai-oss-forks/crossterm/blob/ed1cdab335221515706178d68495bba2aed1924f/src/event.rs#L1453-L1515
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/key_hint.rs#L25-L41
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/config/src/tui_keymap.rs#L704-L751
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/config/src/tui_keymap.rs#L29-L43
const portableKeys = [
  ["enter", "enter"], ["tab", "tab"], ["esc", "esc"],
  ["up", "↑"], ["down", "↓"], ["left", "←"], ["right", "→"],
  ["home", "home"], ["end", "end"], ["page-up", "pgup"], ["page-down", "pgdn"],
  ["space", "space"], ["minus", "-"],
  ...Array.from({ length: 24 }, (_, index) => [`f${index + 1}`, `f${index + 1}`] as const),
] as const;
const platforms = ["macos", "linux", "windows"] as const;
const modified = platforms.flatMap(platform => Array.from({ length: 15 }, (_, index) => {
  const mask = index + 1;
  const names = ["ctrl", "shift", "alt", "super"].filter((_, bit) => (mask & 1 << bit) !== 0);
  const labels = platform === "macos" ? ["⌃", "⇧", "⌥", "⌘"] : platform === "linux" ? ["^", "shift+", "alt+", "super+"] : ["ctrl+", "shift+", "alt+", "super+"];
  const prefix = labels.filter((_, bit) => (mask & 1 << bit) !== 0).join("");
  return { platform, spec: `${names.join("-")}-delete`, display: `${prefix}${platform === "macos" ? "fwd del" : "del"}` };
}));
const asciiCharacters = [...new Set(Array.from({ length: 94 }, (_, index) => String.fromCharCode(index + 33).toLowerCase()))];
export const nativeKeyDisplays = [
  ...platforms.flatMap(platform => [
    ...portableKeys.map(([spec, display]) => ({ platform, spec, display })),
    { platform, spec: "backspace", display: platform === "macos" ? "delete" : "backspace" },
    { platform, spec: "delete", display: platform === "macos" ? "fwd del" : "del" },
  ]),
  ...asciiCharacters.map(display => ({ platform: "portable", spec: display === "-" ? "minus" : display, display })),
  ...modified,
  ...platforms.flatMap(platform => {
    const control = platform === "macos" ? "⌃" : platform === "linux" ? "^" : "ctrl+";
    const forwardDelete = platform === "macos" ? "fwd del" : "del";
    return [
      { platform, spec: "ctrl-x delete", display: `${control}x ${forwardDelete}` },
      { platform, spec: "delete end", display: `${forwardDelete} end` },
      { platform, spec: "ctrl-delete backspace", display: `${control}${forwardDelete} ${platform === "macos" ? "delete" : "backspace"}` },
    ];
  }),
  { platform: "macos", spec: "delete", display: "fwd\ndel" },
  { platform: "macos", spec: "ctrl-delete end", display: "⌃fwd\ndel\nend" },
];
