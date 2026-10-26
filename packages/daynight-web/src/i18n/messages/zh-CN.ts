import { workspace } from "./zh-CN/workspace";
import { graph } from "./zh-CN/graph";
import { platform } from "./zh-CN/platform";
import { automation } from "./zh-CN/automation";
import { inspection } from "./zh-CN/inspection";
import { execution } from "./zh-CN/execution";
import { auth } from "./zh-CN/auth";
import { setup } from "./zh-CN/setup";
import { landing } from "./zh-CN/landing";
import type { Messages } from "../messages";

export const zhCN: Messages = {
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
    retrySave: "重试保存语言",
    status: { todo: "待处理", in_progress: "进行中", done: "已完成" },
    requestId: "请求 ID：",
  },
  language: {
    label: "语言 / Language",
    options: { en: "English", "zh-CN": "简体中文" },
    preferenceNotice: {
      read: "无法读取浏览器保存的语言，已按浏览器语言显示，本次浏览仍可正常切换语言。",
      invalid: "浏览器保存的语言无效，已按浏览器语言显示；重新选择语言可保存新的偏好。",
      write: "语言无法保存到浏览器，本次选择已生效，刷新后可能无法恢复。",
    },
  },
};
