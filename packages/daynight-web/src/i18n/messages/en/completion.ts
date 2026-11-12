import { getFormats } from "../../formats";
import type { CompletionMessages } from "../completion";

export const completion: CompletionMessages = {
  exact: (date) => `Completed: ${date}`,
  viewChain: (title) => `View completion time for ${title}`,
  field: "Completion time",
  justNow: "Completed just now",
  relative: (unit, value) => `Completed ${getFormats("en").number(value)} ${unit}${value === 1 ? "" : "s"} ago`,
  absolute: (date) => `Completed ${date}`,
};
