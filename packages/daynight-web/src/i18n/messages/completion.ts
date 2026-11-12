export type CompletionMessages = {
  readonly exact: (date: string) => string;
  readonly viewChain: (title: string) => string;
  readonly field: string;
  readonly justNow: string;
  readonly relative: (unit: "minute" | "hour" | "day", value: number) => string;
  readonly absolute: (date: string) => string;
};
