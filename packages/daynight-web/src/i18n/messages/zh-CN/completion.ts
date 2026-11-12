import { getFormats } from "../../formats";
import type { CompletionMessages } from "../completion";

export const completion: CompletionMessages = {
  justNow: "刚刚完成",
  relative: (unit, value) => `${getFormats("zh-CN").number(value)} ${ { minute: "分钟", hour: "小时", day: "天" }[unit]}前完成`,
  absolute: (date) => `${date} 完成`,
};
