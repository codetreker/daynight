import { getFormats } from "../../i18n/formats";
import type { Locale } from "../../i18n/locale";
import { messagesByLocale } from "../../i18n/messages";
import type { CompletionReading } from "./model";

export const formatCompletionLabel = (reading: CompletionReading, timestamp: string, locale: Locale): string => {
  const messages = messagesByLocale[locale].completion;
  switch (reading.kind) {
    case "justNow": return messages.justNow;
    case "relative": return messages.relative(reading.unit, reading.value);
    case "absolute": return messages.absolute(getFormats(locale).completionDateTime(timestamp, reading.includeYear));
  }
};
