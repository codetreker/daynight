import { createHash } from "node:crypto";
import path from "node:path";
import { loadOperationFiles } from "../../task/session/private-files.js";
import type { BotOwner } from "./types.js";

/** Private journals share the CLI's filesystem barriers without increasing its record size limit. */
export const withAssistantRuntimeState = async <T>(options: {
  owner: BotOwner; stateDirectory: string; key: string;
}, action: (read: () => Promise<unknown>, save: (value: unknown) => Promise<void>) => Promise<T>): Promise<T> => {
  if (!/^[a-z0-9-]+$/.test(options.key)) throw new Error("Invalid assistant runtime journal key.");
  const origin = createHash("sha256").update(options.owner.serverOrigin).digest("hex");
  const directory = await (await loadOperationFiles()).open(path.join(options.stateDirectory, "assistant-runtime", origin, options.owner.ownerUserId), true);
  if (!directory) throw new Error("Assistant runtime private storage is unavailable.");
  let unlock: (() => Promise<void>) | undefined;
  const index = `${options.key}.json`;
  const manifest = async (): Promise<{ hash: string; chunks: number; slot: 0 | 1 } | null> => {
    const bytes = await directory.read(index);
    if (!bytes) return null;
    const entry = JSON.parse(bytes.toString("utf8")) as { hash: string; chunks: number; slot: 0 | 1 };
    if (!entry || Object.keys(entry).sort().join() !== "chunks,hash,slot" || !/^[a-f0-9]{64}$/.test(entry.hash) || !Number.isInteger(entry.chunks) || entry.chunks < 1 || entry.chunks > 128 || entry.slot !== 0 && entry.slot !== 1) throw new Error("Invalid assistant runtime journal manifest.");
    return entry;
  };
  try {
    unlock = await directory.lock(`${options.key}.lock`);
    return await action(async () => {
      const entry = await manifest();
      if (!entry) return null;
      const chunks: Buffer[] = [];
      for (let i = 0; i < entry.chunks; i++) {
        const chunk = await directory.read(`${options.key}.${entry.slot}.${i}.data`);
        if (!chunk) throw new Error("Assistant runtime journal is incomplete; preserve the original operation.");
        chunks.push(chunk);
      }
      const value = Buffer.concat(chunks);
      if (createHash("sha256").update(value).digest("hex") !== entry.hash) throw new Error("Assistant runtime journal digest mismatch.");
      return JSON.parse(value.toString("utf8")) as unknown;
    }, async value => {
      const bytes = Buffer.from(JSON.stringify(value));
      if (bytes.length > 4 * 1024 * 1024) throw new Error("Assistant runtime journal exceeds 4 MiB.");
      const hash = createHash("sha256").update(bytes).digest("hex"), chunks = Math.ceil(bytes.length / 32768);
      const previous = await manifest(), slot = previous?.slot === 0 ? 1 : 0;
      if (previous?.hash === hash) return;
      for (let i = 0; i < chunks; i++) await directory.replace(`${options.key}.${slot}.${i}.data`, bytes.subarray(i * 32768, (i + 1) * 32768));
      // Only overwrite the inactive bank. The complete previous intent survives partial writes, with storage bounded to two banks.
      await directory.replace(index, Buffer.from(JSON.stringify({ hash, chunks, slot })));
    });
  } finally { try { await unlock?.(); } finally { await directory.close(); } }
};
