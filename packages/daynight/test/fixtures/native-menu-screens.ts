export const nativeMenuScreens = [
  {
    "name": "usage_command_menu",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__usage_command_menu.snap",
    "screen": "  Usage\n  Account usage and resets.\n\n\n› 1. View analytics  Usage history\n  2. Redeem reset    2 available\n\n  enter open · esc back\n"
  },
  {
    "name": "usage_command_menu_before_reset_refresh",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__usage_command_menu_before_reset_refresh.snap",
    "screen": "  Usage\n  Account usage and resets.\n\n\n› 1. View analytics  Usage history\n  2. Redeem reset    Check availability\n\n  enter open · esc back\n"
  },
  {
    "name": "usage_command_menu_narrow",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__usage_command_menu_narrow.snap",
    "screen": "  Usage\n  Account usage and resets.\n\n\n› 1. View analytics\n  2. Redeem reset\n\n  enter open · esc back\n"
  },
  {
    "name": "usage_command_menu_without_resets",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__usage_command_menu_without_resets.snap",
    "screen": "  Usage\n  Account usage and resets.\n\n\n› 1. View analytics  Usage history\n     Redeem reset    None available\n\n  enter open · esc back\n"
  },
  {
    "name": "plugins_popup_curated_marketplace",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__plugins_popup_curated_marketplace.snap",
    "screen": "  Plugins\n  Browse plugins from available marketplaces.\n  Installed 1 of 4 available plugins.\n\n   All Plugins   Installed (1)   OpenAI Curated   Workspace   Repo Marketplace   Add Marketplace\n\n  Type to search plugins\n\n› [ ] Alpha Sync          Disabled         Tab to enable; Enter view details\n  [-] Bravo Search        Available      · OpenAI Curated · Search docs and tickets.\n  [-] Hidden Repo Plugin  Available      · Repo Marketplace · Should not be shown in /plugins.\n  [-] Starter             Admin assigned · OpenAI Curated · Included by default.\n\n\n\n\n\n  ←/→ tabs · enter details · tab toggle · esc close\n"
  },
  {
    "name": "plugins_popup_admin_disabled_installed",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__plugins_popup_admin_disabled_installed.snap",
    "screen": "  Plugins\n  Browse plugins from available marketplaces.\n  Installed 1 of 1 available plugins.\n\n   All Plugins   Installed (1)   OpenAI Curated   Workspace   Add Marketplace\n\n  Type to search plugins\n\n› [!] Admin Blocked  Disabled   Press Enter to view plugin details\n\n\n\n\n\n\n\n\n  ←/→ tabs · enter details · tab toggle · esc close\n"
  },
  {
    "name": "plugins_popup_newly_installed_marketplace",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__plugins_popup_newly_installed_marketplace.snap",
    "screen": "  Plugins\n  Debug Marketplace installed successfully.\n  Select the plugins you want to use and press Enter to install or view details.\n\n   All Plugins   Installed (0)   OpenAI Curated   Workspace   Debug Marketplace   Add Marketplace\n\n  Type to search plugins\n\n› [-] Debug Plugin  Available   Press Enter to install or view plugin details\n\n\n\n\n\n\n\n\n  ⌃u upgrade · ⌃r remove · tab toggle · ←/→ tabs · enter details · esc close\n"
  },
  {
    "name": "plugins_popup_empty_shared_section_hidden",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__plugins_popup_empty_shared_section_hidden.snap",
    "screen": "  Plugins\n  Workspace.\n  This section loaded successfully.\n\n   All Plugins   Installed (0)   OpenAI Curated   Workspace   Add Marketplace\n\n  Type to search plugins\n\n› No workspace plugins available  No workspace directory plugins are available\n\n\n\n\n\n\n\n\n  ←/→ tabs · enter details · tab toggle · esc close\n"
  },
  {
    "name": "plugins_popup_marketplace_remove_confirmation",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__plugins_popup_marketplace_remove_confirmation.snap",
    "screen": "                Plugins\n› Ask Codex to  Remove Repo Marketplace marketplace?\n                This removes the configured marketplace from Codex.\n  GPT-5.6-Sol\n\n              › 1. Remove marketplace  Remove this marketplace from the available\n                                       plugin list\n                2. Back to plugins     Keep this marketplace installed\n\n                enter select · esc close\n"
  },
  {
    "name": "plugin_detail_error_popup",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__plugin_detail_error_popup.snap",
    "screen": "  Plugins\n  Failed to load plugin details.\n\n\n     Plugin detail unavailable  Failed to load plugin details.\n› 1. Back to plugins            Return to the plugin list\n\n  esc close\n"
  },
  {
    "name": "plugin_detail_popup_installable",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__plugin_detail_popup_installable.snap",
    "screen": "  Plugins\n  Figma · Can be installed · Local\n  Data shared with this app is subject to the app's terms of service and privacy policy. Learn\n  more.\n  Turn Figma files into implementation context.\n\n\n› 1. Back to plugins  Return to the plugin list\n  2. Install plugin   Install this plugin now\n     Source           Local\n     Auth             Auth on install\n     Skills           design-review, extract-copy\n     Hooks            PreToolUse (1), Stop (2)\n     Apps             Figma, Slack\n     MCP Servers      figma-mcp, docs-mcp\n\n  esc close\n"
  },
  {
    "name": "plugin_detail_popup_installed",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__plugin_detail_popup_installed.snap",
    "screen": "  Plugins\n  Figma · Installed by admin · ChatGPT Marketplace\n  Turn Figma files into implementation context.\n\n\n› 1. Back to plugins     Return to the plugin list\n     Installed by admin  This plugin is installed by your workspace admin\n     Source              Local\n     Auth                Auth on install\n     Skills              design-review, extract-copy\n     Hooks               PreToolUse (1), Stop (2)\n     Apps                Figma, Slack\n     MCP Servers         figma-mcp, docs-mcp\n\n  esc close\n"
  },
  {
    "name": "plugin_detail_popup_local_share_read_only",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__plugin_detail_popup_local_share_read_only.snap",
    "screen": "  Plugins\n  Docs · Can be installed · Local\n  Data shared with this app is subject to the app's terms of service and privacy policy. Learn more.\n  Workspace docs.\n\n\n› 1. Back to plugins  Return to the plugin list\n  2. Install plugin   Install this plugin now\n     Source           Local\n     Auth             Auth on install\n     Version          remote 7\n     Sharing          Private · creator Test User · https://chatgpt.com/codex/plugins/share/docs\n     Skills           No plugin skills\n     Hooks            No plugin hooks\n↓\n  esc close\n"
  },
  {
    "name": "plugin_detail_popup_npm_source",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__plugin_detail_popup_npm_source.snap",
    "screen": "  Plugins\n  Figma · Can be installed · ChatGPT Marketplace\n  Data shared with this app is subject to the app's terms of service and privacy policy. Learn\n  more.\n  Turn Figma files into implementation context.\n\n\n› 1. Back to plugins  Return to the plugin list\n  2. Install plugin   Install this plugin now\n     Source           npm · @acme/figma-plugin@^1.2.0\n     Auth             Auth on install\n     Skills           design-review, extract-copy\n     Hooks            PreToolUse (1), Stop (2)\n     Apps             Figma, Slack\n     MCP Servers      figma-mcp, docs-mcp\n\n  esc close\n"
  },
  {
    "name": "experimental_features_popup",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__experimental_features_popup.snap",
    "screen": "  Experimental features\n  Checked features are configured on. Some experimental features take effect\n  only in new tasks or after restarting the Codex server.\n\n\n› [ ] JavaScript REPL      Enable a persistent Node-backed JavaScript REPL for\n                           interactive website debugging and other inline\n                           JavaScript execution capabilities.\n  [x] Shell tool           Allow the model to run shell commands.\n  [ ] Voice conversations  Talk with Codex using /voice.\n\n\n  space toggle · enter save · esc save/close\n"
  },
  {
    "name": "experimental_features_popup_configured_key_chords",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__experimental_features_popup_configured_key_chords.snap",
    "screen": "  Experimental features\n  Checked features are configured on. Some experimental features take effect\n  only in new tasks or after restarting the Codex server.\n\n\n› [x] Shell tool  Allow the model to run shell commands.\n\n\n  space toggle · ⌃x enter save · esc save/close\n"
  },
  {
    "name": "experimental_features_empty",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/snapshots/codex_tui__bottom_pane__experimental_features_view__tests__experimental_features_empty.snap",
    "screen": "\n  Experimental features\n  Checked features are configured on. Some experimental features take effect\n  only in new tasks or after restarting the Codex server.\n  No server experiments available.\n\n\n  No experimental features available for now\n\n\n  space toggle · enter save · esc save/close\n"
  },
  {
    "name": "skills_toggle_basic",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/snapshots/codex_tui__bottom_pane__skills_toggle_view__tests__skills_toggle_basic.snap",
    "screen": "                                                                        \n  Enable/Disable Skills                                                 \n  Turn skills on or off. Your changes are saved automatically.          \n                                                                        \n  Type to search skills                                                 \n                                                                        \n› [x] Repo Scout        Summarize the repo layout                       \n  [ ] Changelog Writer  Draft release notes                             \n                                                                        \n                                                                        \n                                                                        \n  space/enter toggle · esc close\n"
  },
  {
    "name": "skills_toggle_long_names_at_narrow_width",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/snapshots/codex_tui__bottom_pane__skills_toggle_view__tests__skills_toggle_long_names_at_narrow_width.snap",
    "screen": "                                                \n  Enable/Disable Skills                         \n  Turn skills on or off. Your changes are       \n  saved automatically.                          \n                                                \n  Type to search skills                         \n                                                \n› [x] superpowers-systematic-debugging (polish) \n  [ ] superpowers-verification-before-completio…\n                                                \n                                                \n                                                \n  space/enter toggle · esc close\n"
  },
  {
    "name": "skills_toggle_long_names_use_available_width",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/snapshots/codex_tui__bottom_pane__skills_toggle_view__tests__skills_toggle_long_names_use_available_width.snap",
    "screen": "                                                                                                \n  Enable/Disable Skills                                                                         \n  Turn skills on or off. Your changes are saved automatically.                                  \n                                                                                                \n  Type to search skills                                                                         \n                                                                                                \n› [x] superpowers-systematic-debugging (polish)            Find root causes before fixing bugs  \n  [ ] superpowers-verification-before-completion (polish)  Verify completion before claiming su…\n                                                                                                \n                                                                                                \n                                                                                                \n  space/enter toggle · esc close\n"
  },
  {
    "name": "resume_picker_118x30",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/snapshots/codex_tui__resume_picker__color_tests__compact_picker_keeps_metadata_and_labeled_primary_actions.snap",
    "screen": " Resume a previous session\n\n Filter:  Cwd  All    Status:  Active  Archived    Sort:  Updated  Created\n\n Type to search\n\n  › Session 1                                                                                                       \n    now            fcoury/contrast                                                                                 \n\n    Session 2\n    now            fcoury/contrast\n\n    Session 3                                                                                                       \n    now            fcoury/contrast                                                                                 \n\n    Session 4\n    now            fcoury/contrast\n\n    Session 5                                                                                                       \n    now            fcoury/contrast                                                                                 \n\n    Session 6\n    now            fcoury/contrast\n\n\n\n─────────────────────────────────────────────────────────────────────────────────────────────────────── 1 / 6 · 100% ─\n enter resume   ⌃a archive   esc new   ⌃c quit   tab focus   ←/→ option\n ⌃o dense   ⌃t preview   ⌃e exp   ↑/↓ browse\n"
  },
  {
    "name": "plugins_popup_loading_state",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__plugins_popup_loading_state.snap",
    "screen": "  Plugins\n  Loading available plugins...\n  This updates when the marketplace list is ready.\n\n\n›    Loading plugins...  This updates when the marketplace list is ready\n\n  enter select · esc back\n"
  },
  {
    "name": "experimental_features_saving",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/snapshots/codex_tui__bottom_pane__experimental_features_view__tests__experimental_features_saving.snap",
    "screen": "\n  Experimental features\n  Checked features are configured on. Some experimental features take effect\n  only in new tasks or after restarting the Codex server.\n  Saving experimental features…\n\n\n› [ ] Server network_proxy       Description supplied by the server.\n  [ ] Server future_feature      Description supplied by the server.\n  [ ] Server prevent_idle_sleep  Description supplied by the server.\n\n\n  Saving… Closing this popup will not cancel the write.\n"
  },
  {
    "name": "experimental_features_save_failed",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/snapshots/codex_tui__bottom_pane__experimental_features_view__tests__experimental_features_save_failed.snap",
    "screen": "\n  Experimental features\n  Checked features are configured on. Some experimental features take effect\n  only in new tasks or after restarting the Codex server.\n  Saved but readback failed\n\n\n› [ ] Server network_proxy       Description supplied by the server.\n  [ ] Server future_feature      Description supplied by the server.\n  [ ] Server prevent_idle_sleep  Description supplied by the server.\n\n\n  Selections retained. Save to retry, or cancel to close.\n"
  },
  {
    "name": "status_line_setup_popup_hardcoded_only",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__status_line_setup_popup_hardcoded_only.snap",
    "screen": "  Configure Status Line\n  Select which items to display in the status line.\n\n  Type to search\n\n› [x] Use theme colors      Apply colors from the active /theme\n  ───────────────────────\n  [x] project-name          Project name (omitted when unavailable)\n  [x] git-branch            Current Git branch (omitted when unavailable)\n  [x] thread-title          Current thread title, or thread identifier when unnamed\n  [ ] model                 Current model name\n  [ ] model-with-reasoning  Current model name with reasoning level\n  [ ] reasoning             Current reasoning level\n↓\n  my-project · feat/awesome-feature · thread title\n  space toggle · ←/→ reorder · enter save · esc cancel\n"
  },
  {
    "name": "status_line_setup_popup_live_only",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__status_line_setup_popup_live_only.snap",
    "screen": "  Configure Status Line\n  Select which items to display in the status line.\n\n  Type to search\n\n› [x] Use theme colors      Apply colors from the active /theme\n  ───────────────────────\n  [x] project-name          Project name (omitted when unavailable)\n  [x] git-branch            Current Git branch (omitted when unavailable)\n  [x] thread-title          Current thread title, or thread identifier when unnamed\n  [ ] model                 Current model name\n  [ ] model-with-reasoning  Current model name with reasoning level\n  [ ] reasoning             Current reasoning level\n↓\n  preview-live-root · feature/live-preview-branch · Live preview thread\n  space toggle · ←/→ reorder · enter save · esc cancel\n"
  },
  {
    "name": "status_line_setup_popup_mixed",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__status_line_setup_popup_mixed.snap",
    "screen": "  Configure Status Line\n  Select which items to display in the status line.\n\n  Type to search\n\n› [x] Use theme colors      Apply colors from the active /theme\n  ───────────────────────\n  [x] project-name          Project name (omitted when unavailable)\n  [x] git-branch            Current Git branch (omitted when unavailable)\n  [x] thread-title          Current thread title, or thread identifier when unnamed\n  [x] daybreak              Whether Daybreak is enabled for this thread\n  [ ] model                 Current model name\n  [ ] model-with-reasoning  Current model name with reasoning level\n↓\n  my-project · feature/mixed-preview · Mixed preview thread · Daybreak on\n  space toggle · ←/→ reorder · enter save · esc cancel\n"
  },
  {
    "name": "status_line_setup_popup_rate_limits",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__status_line_setup_popup_rate_limits.snap",
    "screen": "  Configure Status Line\n  Select which items to display in the status line.\n\n  Type to search\n\n› [x] Use theme colors      Apply colors from the active /theme\n  ───────────────────────\n  [x] monthly-limit         Remaining usage on the monthly usage limit (omitted when unavailable)\n  [x] weekly-limit          Remaining usage on the weekly usage limit (omitted when unavailable)\n  [ ] model                 Current model name\n  [ ] model-with-reasoning  Current model name with reasoning level\n  [ ] reasoning             Current reasoning level\n  [ ] current-dir           Current working directory\n↓\n  monthly 65% left · weekly 50% left\n  space toggle · ←/→ reorder · enter save · esc cancel\n"
  },
  {
    "name": "status_line_setup_popup_workspace_headline",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__status_line_setup_popup_workspace_headline.snap",
    "screen": "  Configure Status Line\n  Select which items to display in the status line.\n\n  Type to search\n\n› [x] Use theme colors      Apply colors from the active /theme\n  ───────────────────────\n  [x] workspace-headline    Workspace notification headline (Enterprise workspaces only; omitted wh…\n  [ ] model                 Current model name\n  [ ] model-with-reasoning  Current model name with reasoning level\n  [ ] reasoning             Current reasoning level\n  [ ] current-dir           Current working directory\n  [ ] project-name          Project name (omitted when unavailable)\n↓\n  Workspace maintenance starts at 5pm\n  space toggle · ←/→ reorder · enter save · esc cancel\n"
  },
  {
    "name": "terminal_title_setup_popup_hardcoded_only",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__terminal_title_setup_popup_hardcoded_only.snap",
    "screen": "  Configure Terminal Title\n  Select which items to display in the terminal title.\n\n  Type to search\n\n› [x] thread-title   Current thread title, or thread identifier when unnamed\n  [x] git-branch     Current Git branch (omitted when unavailable)\n  [x] task-progress  Latest task progress from update_plan (omitted until available)\n  [ ] app-name       Codex app name\n  [ ] project-name   Project name (falls back to current directory name)\n  [ ] current-dir    Current working directory\n  [ ] activity       Spinner while working, action-required message while blocked\n  [ ] run-state      Compact session run-state text (Ready, Working, Thinking)\n↓\n  thread title | feat/awesome-feature | Tasks 0/0\n  space toggle · ←/→ reorder · enter save · esc cancel\n"
  },
  {
    "name": "terminal_title_setup_popup_live_only",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__terminal_title_setup_popup_live_only.snap",
    "screen": "  Configure Terminal Title\n  Select which items to display in the terminal title.\n\n  Type to search\n\n› [x] project-name   Project name (falls back to current directory name)\n  [x] thread-title   Current thread title, or thread identifier when unnamed\n  [x] git-branch     Current Git branch (omitted when unavailable)\n  [x] task-progress  Latest task progress from update_plan (omitted until available)\n  [ ] app-name       Codex app name\n  [ ] current-dir    Current working directory\n  [ ] activity       Spinner while working, action-required message while blocked\n  [ ] run-state      Compact session run-state text (Ready, Working, Thinking)\n↓\n  preview-live-root | Live preview thread | feature/live-preview-branch | Tasks 2/5\n  space toggle · ←/→ reorder · enter save · esc cancel\n"
  },
  {
    "name": "terminal_title_setup_popup_mixed",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__terminal_title_setup_popup_mixed.snap",
    "screen": "  Configure Terminal Title\n  Select which items to display in the terminal title.\n\n  Type to search\n\n› [x] project-name   Project name (falls back to current directory name)\n  [x] thread-title   Current thread title, or thread identifier when unnamed\n  [x] task-progress  Latest task progress from update_plan (omitted until available)\n  [x] daybreak       Whether Daybreak is enabled for this thread\n  [ ] app-name       Codex app name\n  [ ] current-dir    Current working directory\n  [ ] activity       Spinner while working, action-required message while blocked\n  [ ] run-state      Compact session run-state text (Ready, Working, Thinking)\n↓\n  project | Mixed preview thread | Tasks 0/0 | Daybreak on\n  space toggle · ←/→ reorder · enter save · esc cancel\n"
  },
  {
    "name": "terminal_title_setup_popup_rate_limits",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__terminal_title_setup_popup_rate_limits.snap",
    "screen": "  Configure Terminal Title\n  Select which items to display in the terminal title.\n\n  Type to search\n\n› [x] monthly-limit  Remaining usage on the monthly usage limit (omitted when unavailable)\n  [x] weekly-limit   Remaining usage on the weekly usage limit (omitted when unavailable)\n  [ ] app-name       Codex app name\n  [ ] project-name   Project name (falls back to current directory name)\n  [ ] current-dir    Current working directory\n  [ ] activity       Spinner while working, action-required message while blocked\n  [ ] run-state      Compact session run-state text (Ready, Working, Thinking)\n  [ ] thread-name    Current thread name (omitted when unnamed)\n↓\n  monthly 65% left | weekly 50% left\n  space toggle · ←/→ reorder · enter save · esc cancel\n"
  },
  {
    "name": "terminal_title_setup_popup_thread_usage",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__terminal_title_setup_popup_thread_usage.snap",
    "screen": "  Configure Terminal Title\n  Select which items to display in the terminal title.\n\n  Type to search\n\n› [x] thread-credits         Estimated current-thread credits (Enterprise workspaces only; omitted …\n  [x] estimated-thread-cost  Estimated current-thread cost (Enterprise workspaces only; omitted whe…\n  [ ] app-name               Codex app name\n  [ ] project-name           Project name (falls back to current directory name)\n  [ ] current-dir            Current working directory\n  [ ] activity               Spinner while working, action-required message while blocked\n  [ ] run-state              Compact session run-state text (Ready, Working, Thinking)\n  [ ] thread-name            Current thread name (omitted when unnamed)\n↓\n  5.2 credits | ~$1.82\n  space toggle · ←/→ reorder · enter save · esc cancel\n"
  },
  {
    "name": "voice_input_channel_subset",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__realtime_settings__tests__voice_input_channel_subset.snap",
    "screen": "  Microphone: Zen Go Synergy Core Playback\n  Select the input channels to mix. Select at least one.\n\n  Type to search\n\n  [x] Input 1\n› [x] Input 2\n  [ ] Input 3\n  [ ] Input 4\n\n  space toggle · enter save · esc cancel\n"
  },
  {
    "name": "voice_input_channels",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__realtime_settings__tests__voice_input_channels.snap",
    "screen": "  Microphone: Zen Go Synergy Core Playback\n  Select the input channels to mix. Select at least one.\n\n  Type to search\n\n› [x] Input 1\n  [ ] Input 2\n  [ ] Input 3\n  [ ] Input 4\n\n  space toggle · enter save · esc cancel\n"
  },
  {
    "name": "voice_input_channels_empty",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__realtime_settings__tests__voice_input_channels_empty.snap",
    "screen": "  Microphone: Mic\n  Select the input channels to mix. Select at least one.\n\n  Type to search\n\n› [ ] Input 1\n  [ ] Input 2\n  [ ] Input 3\n  [ ] Input 4\n\n  Select at least one input channel.\n  space toggle · enter save · esc cancel\n"
  },
  {
    "name": "setup_view_snapshot_includes_hostname",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/snapshots/codex_tui__bottom_pane__status_line_setup__tests__setup_view_snapshot_includes_hostname.snap",
    "screen": "\n  Configure Status Line\n  Select which items to display in the status line.\n\n  Type to search\n\n› [x] Use theme colors      Apply colors from the active /theme\n  ───────────────────────\n  [x] hostname              Current machine hostname (omitted when unavailable)\n  [x] current-dir           Current working directory\n  [ ] model                 Current model name\n  [ ] model-with-reasoning  Current model name with reasoning level\n  [ ] reasoning             Current reasoning level\n  [ ] project-name          Project name (omitted when unavailable)\n↓\n  ssh-build-01.example.com · ~/codex-rs\n  space toggle · ←/→ reorder · enter save · esc cancel\n"
  },
  {
    "name": "setup_view_snapshot_includes_thread_usage_items",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/snapshots/codex_tui__bottom_pane__status_line_setup__tests__setup_view_snapshot_includes_thread_usage_items.snap",
    "screen": "                                                                                                    \n  Configure Status Line                                                                             \n  Select which items to display in the status line.                                                 \n                                                                                                    \n  Type to search                                                                                    \n                                                                                                    \n› [x] Use theme colors       Apply colors from the active /theme                                    \n  ───────────────────────                                                                           \n  [x] thread-credits         Estimated current-thread credits (Enterprise workspaces only; omitted …\n  [x] estimated-thread-cost  Estimated current-thread cost in USD (Enterprise workspaces only; omit…\n  [ ] model                  Current model name                                                     \n  [ ] model-with-reasoning   Current model name with reasoning level                                \n  [ ] reasoning              Current reasoning level                                                \n  [ ] current-dir            Current working directory                                              \n↓                                                                                                   \n  5.2 credits · ~$1.82                                                                              \n  space toggle · ←/→ reorder · enter save · esc cancel\n"
  },
  {
    "name": "setup_view_snapshot_uses_runtime_preview_values",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/snapshots/codex_tui__bottom_pane__status_line_setup__tests__setup_view_snapshot_uses_runtime_preview_values.snap",
    "screen": "                                                                        \n  Configure Status Line                                                 \n  Select which items to display in the status line.                     \n                                                                        \n  Type to search                                                        \n                                                                        \n› [x] Use theme colors      Apply colors from the active /theme         \n  ───────────────────────                                               \n  [x] model                 Current model name                          \n  [x] current-dir           Current working directory                   \n  [x] git-branch            Current Git branch (omitted when unavailabl…\n  [ ] model-with-reasoning  Current model name with reasoning level     \n  [ ] reasoning             Current reasoning level                     \n  [ ] project-name          Project name (omitted when unavailable)     \n↓                                                                       \n  gpt-5-codex · ~/codex-rs · jif/statusline-preview                     \n  space toggle · ←/→ reorder · enter save · esc cancel\n"
  },
  {
    "name": "terminal_title_setup_basic",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/snapshots/codex_tui__bottom_pane__title_setup__tests__terminal_title_setup_basic.snap",
    "screen": "                                                                                    \n  Configure Terminal Title                                                          \n  Select which items to display in the terminal title.                              \n                                                                                    \n  Type to search                                                                    \n                                                                                    \n› [x] project-name  Project name (falls back to current directory name)             \n  [x] activity      Spinner while working, action-required message while blocked    \n  [x] run-state     Compact session run-state text (Ready, Working, Thinking)       \n  [x] thread-title  Current thread title, or thread identifier when unnamed         \n  [ ] app-name      Codex app name                                                  \n  [ ] current-dir   Current working directory                                       \n  [ ] thread-name   Current thread name (omitted when unnamed)                      \n  [ ] git-branch    Current Git branch (omitted when unavailable)                   \n↓                                                                                   \n  [ ! ] Action Required | my-project | Working | thread title                       \n  space toggle · ←/→ reorder · enter save · esc cancel\n"
  },
  {
    "name": "multi_select_first_page",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/snapshots/codex_tui__bottom_pane__multi_select_picker__tests__picker_appearance_renders_checkboxes_preview_and_overflow.snap",
    "screen": "                                                \n  Status line                                   \n                                                \n  Type to search                                \n                                                \n› [x] Field 0              Status detail        \n  ───────────────────────                       \n  [ ] Field 1              Status detail        \n  [ ] Field 2              Status detail        \n  [ ] Field 3              Status detail        \n  [ ] Field 4              Status detail        \n  [ ] Field 5              Status detail        \n  [ ] Field 6              Status detail        \n↓                                               \n  Field 0                                       \n  space toggle · ←/→ reorder · enter save · esc \n  cancel                                        \n"
  },
  {
    "name": "multi_select_last_page",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/snapshots/codex_tui__bottom_pane__multi_select_picker__tests__picker_appearance_renders_checkboxes_preview_and_overflow.snap",
    "screen": "                                                \n  Status line                                   \n                                                \n  Type to search                                \n↑                                               \n  [ ] Field 4   Status detail                   \n  [ ] Field 5   Status detail                   \n  [ ] Field 6   Status detail                   \n  [ ] Field 7   Status detail                   \n  [ ] Field 8   Status detail                   \n  [ ] Field 9   Status detail                   \n› [x] Field 11  Status detail                   \n  [ ] Field 10  Status detail                   \n                                                \n  Field 0 · Field 11                            \n  space toggle · ←/→ reorder · enter save · esc \n  cancel                                        \n"
  },
  {
    "name": "multi_select_no_matches",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/snapshots/codex_tui__bottom_pane__multi_select_picker__tests__picker_appearance_renders_checkboxes_preview_and_overflow.snap",
    "screen": "                                                \n  Status line                                   \n                                                \n  z                                             \n                                                \nno matches                                      \n                                                \n  Field 0 · Field 11                            \n  space toggle · ←/→ reorder · enter save · esc \n  cancel                                        \n"
  },
  {
    "name": "multi_select_height_1",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/snapshots/codex_tui__bottom_pane__multi_select_picker__tests__short_picker_preserves_selected_row_when_overflow_spacers_yield.snap",
    "screen": "  space toggle · ←/→ reorder · enter save · esc cancel\n"
  },
  {
    "name": "multi_select_height_2",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/snapshots/codex_tui__bottom_pane__multi_select_picker__tests__short_picker_preserves_selected_row_when_overflow_spacers_yield.snap",
    "screen": "\n  space toggle · ←/→ reorder · enter save · esc cancel\n"
  },
  {
    "name": "multi_select_height_3",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/snapshots/codex_tui__bottom_pane__multi_select_picker__tests__short_picker_preserves_selected_row_when_overflow_spacers_yield.snap",
    "screen": "\n  Type to search\n  space toggle · ←/→ reorder · enter save · esc cancel\n"
  },
  {
    "name": "multi_select_height_4",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/snapshots/codex_tui__bottom_pane__multi_select_picker__tests__short_picker_preserves_selected_row_when_overflow_spacers_yield.snap",
    "screen": "\n  Type to search\n› [ ] field-11\n  space toggle · ←/→ reorder · enter save · esc cancel\n"
  },
  {
    "name": "multi_select_height_5",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/snapshots/codex_tui__bottom_pane__multi_select_picker__tests__short_picker_preserves_selected_row_when_overflow_spacers_yield.snap",
    "screen": "\n  Type to search\n  [ ] field-10\n› [ ] field-11\n  space toggle · ←/→ reorder · enter save · esc cancel\n"
  },
  {
    "name": "multi_select_height_6",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/snapshots/codex_tui__bottom_pane__multi_select_picker__tests__short_picker_preserves_selected_row_when_overflow_spacers_yield.snap",
    "screen": "\n  Type to search\n↑\n› [ ] field-11\n\n  space toggle · ←/→ reorder · enter save · esc cancel\n"
  },
  {
    "name": "multi_select_height_7",
    "source": "https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/snapshots/codex_tui__bottom_pane__multi_select_picker__tests__short_picker_preserves_selected_row_when_overflow_spacers_yield.snap",
    "screen": "\n  Type to search\n↑\n  [ ] field-10\n› [ ] field-11\n\n  space toggle · ←/→ reorder · enter save · esc cancel\n"
  }
];
