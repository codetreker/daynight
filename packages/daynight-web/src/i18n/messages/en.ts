import { workspace } from "./en/workspace";
import { graph } from "./en/graph";
import { platform } from "./en/platform";
import { automation } from "./en/automation";
import { inspection } from "./en/inspection";
import { execution } from "./en/execution";
import { auth } from "./en/auth";
import { setup } from "./en/setup";
import { landing } from "./en/landing";
import type { Messages } from "../messages";

export const en: Messages = {
  workspace,
  graph,
  inspection,
  automation,
  platform,
  auth,
  setup,
  landing,
  execution,
  common: {
    retrySave: "Retry saving language",
    status: { todo: "To do", in_progress: "In progress", done: "Done" },
    requestId: "Request ID:",
  },
  language: {
    label: "语言 / Language",
    options: { en: "English", "zh-CN": "简体中文" },
    preferenceNotice: {
      read: "The saved language could not be read. Browser language is used; switching languages still works for this visit.",
      invalid: "The saved language is invalid. Browser language is used; choose a language to save a new preference.",
      write: "The language could not be saved. Your choice applies now, but may not return after a reload.",
    },
  },
};
