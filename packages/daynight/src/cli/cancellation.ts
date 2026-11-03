import type { CliContext } from "./context.js";

export class CliCancelledError extends Error {
  constructor(message = "Operation cancelled.", options?: ErrorOptions) {
    super(message, options);
    this.name = "CliCancelledError";
  }
}

export const withCliCancellation = async <Result>(
  context: Pick<CliContext, "prompt">,
  action: (signal: AbortSignal) => Promise<Result>,
  supplied?: AbortSignal,
  cancellation: () => Error = () => new CliCancelledError(),
): Promise<Result> => {
  const controller = new AbortController();
  const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
  const cancel = (): void => controller.abort(cancellation());
  if (supplied === undefined) for (const signal of signals) process.on(signal, cancel);
  try { return await action(supplied ?? controller.signal); }
  finally {
    if (supplied === undefined) for (const signal of signals) process.off(signal, cancel);
    context.prompt?.close();
  }
};
