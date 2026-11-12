export type CompletionMessages = {
  readonly justNow: string;
  readonly relative: (unit: "minute" | "hour" | "day", value: number) => string;
  readonly absolute: (date: string) => string;
};
