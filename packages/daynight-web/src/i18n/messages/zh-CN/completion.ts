import { getFormats } from "../../formats";
import type { CompletionMessages } from "../completion";

export const completion: CompletionMessages = {
  exact: (date) => `完成时间：${date}`,
  viewChain: (title) => `查看 ${title} 的完成时间`,
  field: "完成时间",
  justNow: "刚刚完成",
  relative: (unit, value) => `${getFormats("zh-CN").number(value)} ${ { minute: "分钟", hour: "小时", day: "天" }[unit]}前完成`,
  absolute: (date) => `${date} 完成`,
};
