import { createInterface } from "node:readline";
import type { Interface } from "node:readline";
import { CliCancelledError } from "./cancellation.js";

export type PromptChoice<Value> = { name: string; value: Value };
export type PromptSelection<Value> = { message: string; choices: readonly PromptChoice<Value>[]; default: Value };
export type PromptMultipleSelection<Value> = { message: string; choices: readonly PromptChoice<Value>[]; requiredMessage: string };

export type CliPrompt = {
  readonly isInteractive: boolean;
  ask(question: string, signal: AbortSignal): Promise<string>;
  select<Value>(selection: PromptSelection<Value>, signal: AbortSignal): Promise<Value>;
  selectMany<Value>(selection: PromptMultipleSelection<Value>, signal: AbortSignal): Promise<Value[]>;
  close(): void;
};

export const createTerminalPrompt = (): CliPrompt => {
  let terminal: Interface | undefined;
  let closed = false;
  let selecting = false;
  const closing = new AbortController();
  const lines: string[] = [];
  let waiting: { resolve: (line: string) => void; reject: (cause: unknown) => void } | undefined;
  const cancel = (): void => {
    closed = true;
    closing.abort(new CliCancelledError());
    waiting?.reject(new CliCancelledError("Setup cancelled."));
    waiting = undefined;
  };
  const selection = async <Value>(signal: AbortSignal, action: (context: { input: typeof process.stdin; output: typeof process.stderr; signal: AbortSignal }) => Promise<Value>): Promise<Value> => {
    signal.throwIfAborted();
    if (closed) throw new CliCancelledError();
    selecting = true;
    terminal?.pause();
    try {
      return await action({ input: process.stdin, output: process.stderr, signal: AbortSignal.any([signal, closing.signal]) });
    } catch (cause) {
      if (cause instanceof Error && ["ExitPromptError", "AbortPromptError"].includes(cause.name)) throw new CliCancelledError(undefined, { cause });
      throw cause;
    } finally {
      selecting = false;
      if (!closed) terminal?.resume();
    }
  };
  return {
    isInteractive: process.stdin.isTTY === true && process.stderr.isTTY === true,
    ask: async (question, signal) => {
      signal.throwIfAborted();
      if (closed) throw new CliCancelledError("Setup cancelled.");
      if (terminal === undefined) {
        terminal = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
        terminal.on("line", (line) => {
          if (selecting) return;
          if (waiting === undefined) lines.push(line);
          else { const pending = waiting; waiting = undefined; pending.resolve(line); }
        });
        terminal.on("close", cancel);
        terminal.on("SIGINT", cancel);
      }
      process.stderr.write(question);
      if (lines.length !== 0) return lines.shift()!;
      return new Promise<string>((resolve, reject) => {
        const abort = (): void => { waiting = undefined; reject(new CliCancelledError("Setup cancelled.", { cause: signal.reason })); };
        waiting = {
          resolve: (line) => { signal.removeEventListener("abort", abort); resolve(line); },
          reject: (cause) => { signal.removeEventListener("abort", abort); reject(cause); },
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    },
    select: async <Value>(config: PromptSelection<Value>, signal: AbortSignal): Promise<Value> => selection(signal, async (context) => {
      const { select } = await import("@inquirer/prompts");
      return select({ ...config, choices: [...config.choices] }, context);
    }),
    selectMany: async <Value>(config: PromptMultipleSelection<Value>, signal: AbortSignal): Promise<Value[]> => selection(signal, async (context) => {
      const { checkbox } = await import("@inquirer/prompts");
      return checkbox({ message: config.message, choices: [...config.choices], validate: (values) => values.length > 0 || config.requiredMessage }, context);
    }),
    close: () => { cancel(); terminal?.close(); },
  };
};
