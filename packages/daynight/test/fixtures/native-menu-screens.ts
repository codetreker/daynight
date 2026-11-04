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
  }
];
