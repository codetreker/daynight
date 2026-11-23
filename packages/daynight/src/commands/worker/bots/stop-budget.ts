export type BotStopOptions = { deadline?: number };

/** A timeout limits waiting; the original work still owns its resources. */
export const joinBotWork = async <T>(work: Promise<T>, deadline: number, subject: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${subject} did not join before the stop deadline; resource responsibility is retained.`)), Math.max(0, deadline - Date.now()));
    })]);
  } finally { clearTimeout(timer); }
};

export const botStopDeadline = (options?: BotStopOptions): number => {
  const deadline = options?.deadline ?? Date.now() + 20_000;
  if (!Number.isFinite(deadline)) throw new TypeError("Bot stop deadline must be finite.");
  return Math.min(deadline, Date.now() + 20_000);
};
