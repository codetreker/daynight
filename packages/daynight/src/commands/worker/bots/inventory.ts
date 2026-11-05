import { parseBot, parseBotOwner, type Bot, type BotOwner } from "./types.js";
import type { BotStore } from "./store.js";
import type { BotRemote } from "./remote.js";

export type BotInventoryResult = { observed: string[]; missing: string[] };

/** Reconcile observations without releasing local execution or deletion responsibility. */
export const createBotInventory = (options: { owner: BotOwner; store: BotStore; remote: BotRemote; now?: () => number }) => {
  const owner = parseBotOwner(options.owner), remoteOwner = parseBotOwner(options.remote.owner);
  if (owner.serverOrigin !== remoteOwner.serverOrigin || owner.ownerUserId !== remoteOwner.ownerUserId || owner.workerId !== remoteOwner.workerId) throw new Error("Bot remote service, owner and Worker must match the local inventory.");
  const now = options.now ?? Date.now;
  let reconciling = false;
  return {
    reconcile: async (signal: AbortSignal): Promise<BotInventoryResult> => {
      if (reconciling) throw new Error("Bot inventory reconciliation is already running.");
      reconciling = true;
      try {
        signal.throwIfAborted();
        const local = options.store.list(owner);
        const listed = await options.remote.list(signal);
        signal.throwIfAborted();
        const observations = new Map<string, Bot>(), uncertain = new Set<string>();
        for (const input of listed) {
          const bot = parseBot(input, owner);
          if (observations.has(bot.id)) uncertain.add(bot.id);
          observations.set(bot.id, bot);
        }
        for (const record of local) if (!observations.has(record.botId)) uncertain.add(record.botId);
        const missing: string[] = [];
        // A paged list is not a snapshot. Re-read duplicates and omissions before any writes.
        for (const botId of uncertain) {
          signal.throwIfAborted();
          const detail = await options.remote.read(botId, signal);
          if (detail === null) { observations.delete(botId); missing.push(botId); continue; }
          const bot = parseBot(detail, owner);
          if (bot.id !== botId) throw new Error("Bot detail identity differs from its inventory responsibility.");
          observations.set(botId, bot);
        }
        signal.throwIfAborted();
        const observedAt = now();
        const observed = [...observations.keys()].sort();
        for (const botId of observed) options.store.observe(owner, observations.get(botId)!, observedAt);
        return { observed, missing: missing.sort() };
      } finally { reconciling = false; }
    },
  };
};
