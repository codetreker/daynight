// Source-derived existing-session frames, not native acceptance captures.
// list.accept = ["ctrl-shift-alt-super-delete", "enter"] displays the first binding.
// At these widths the primary label fits, but adding the higher-priority esc exit does not;
// the renderer prunes secondary controls before falling back to key-only hints.
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/resume_picker.rs#L2475-L2618
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/resume_picker.rs#L2695-L2755
export const narrowSessionPickerScreens = [
  { action: "resume", title: "Resume", width: 28 },
  { action: "fork", title: "Fork", width: 26 },
  { action: "restore", title: "Resume", width: 28 },
].map(({ action, title, width }) => ({
  action, width,
  screen: ` ${title} a previous session

 Type to search

  › Original session
    now

${"─".repeat(width)}
 ⌃⇧⌥⌘fwd del ${action}
 ⌃o dense   ⌃t preview`,
}));

// A failed density save replaces search with a clipped inline error while the
// expanded selected row keeps its native marker. These are admission rows only.
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/resume_picker.rs#L1953-L1960
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/resume_picker.rs#L3070-L3076
export const expandedNarrowSessionPickerScreens = narrowSessionPickerScreens.map(frame => ({
  ...frame,
  screen: frame.screen
    .replace("Type to search", frame.width === 26 ? "Failed to save view mo..." : "Failed to save view mode...")
    .replace("› Original session", "⌄ Original session"),
}));
