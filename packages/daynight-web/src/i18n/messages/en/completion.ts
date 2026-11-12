import { getFormats } from "../../formats";
import type { CompletionMessages } from "../completion";

export const completion: CompletionMessages = {
  justNow: "Completed just now",
  relative: (unit, value) => `Completed ${getFormats("en").number(value)} ${unit}${value === 1 ? "" : "s"} ago`,
  absolute: (date) => `Completed ${date}`,
};
