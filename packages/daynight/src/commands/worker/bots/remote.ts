import { ApiError } from "../../../api/client.js";
import { createOperation, type Operation } from "../../../api/operation.js";
import { parseServerError, ProtocolError } from "../../../api/parse.js";
import { validateServerToken, validateTokenTransport } from "../../../config/server-token.js";
import { botUUID, parseBot, parseBotOwner, type Bot, type BotOwner } from "./types.js";
import { parseBotDeletionRecovery, type BotDeletionRecovery } from "../../bot/deletion-api.js";

export type BotRemote = {
  readonly owner: Readonly<BotOwner>;
  list(signal: AbortSignal): Promise<readonly Bot[]>;
  read(botId: string, signal: AbortSignal, originalOwner?: BotOwner): Promise<Bot | null>;
  readDeletionRecovery?(botId: string, signal: AbortSignal, originalOwner?: BotOwner): Promise<BotDeletionRecovery | null>;
};

/** Read only the original service/account/Worker binding; no creation or execution requests. */
export const createBotRemote = (options: { owner: BotOwner; serverToken: string }): BotRemote => {
  const owner = Object.freeze(parseBotOwner(options.owner));
  const token = validateServerToken(options.serverToken);
  const missing = Symbol("confirmed-missing-bot");
  validateTokenTransport(owner.serverOrigin);
  const request = async (target: string, operation: Operation, allowMissing = false, optionalCapability = false): Promise<unknown> => {
    operation.check();
    const response = await fetch(`${owner.serverOrigin}${target}`, {
      method: "GET", redirect: "error", headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.any([operation.signal, AbortSignal.timeout(operation.limits.requestMs)]),
    });
    try {
      // An unregistered route on older services is a plain mux 404 without a
      // principal header. This signals only missing capability, never absence
      // of a Bot or proof that its execution is safe to clean.
      if (optionalCapability && response.status === 404) return missing;
      if (response.headers.get("Daynight-User-ID") !== owner.ownerUserId) throw new ProtocolError("Bot response principal does not match the inventory owner.");
      if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new ProtocolError("Bot response must be JSON.");
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader !== undefined) {
        try {
          while (true) {
            operation.check();
            const item = await reader.read();
            if (item.done) break;
            operation.consume(item.value.byteLength);
            size += item.value.byteLength;
            if (size > operation.limits.responseBytes) throw new ProtocolError("Bot response exceeds its byte limit.");
            chunks.push(item.value);
          }
        } finally { reader.releaseLock(); }
      }
      operation.check();
      let value: unknown;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw new ProtocolError("Bot response contains invalid JSON or UTF-8."); }
      if (response.status !== 200) {
        const error = parseServerError(value);
        if (allowMissing && response.status === 404 && error.code === "not_found") return missing;
        throw new ApiError({ operation: "worker.bots.read" }, "response", { status: response.status, serverError: error, cause: new Error("Bot inventory request failed.") });
      }
      return value;
    } finally { if (response.body !== null && !response.body.locked) await response.body.cancel(); }
  };
  // A count-based page can contain the complete inventory within its existing budget.
  const inventoryBytes = 64 * 1024 * 1024;
  const operation = (signal: AbortSignal): Operation => createOperation({ signal, limits: { responseBytes: inventoryBytes, totalBytes: inventoryBytes } });
  return {
    owner,
    list: async signal => {
      const read = operation(signal);
      try {
        const items: Bot[] = [], cursors = new Set<string>();
        let cursor: string | null = null;
        do {
          const query = new URLSearchParams({ limit: "100", ...(cursor === null ? {} : { cursor }) });
          const value = await request(`/api/v1/me/workers/${owner.workerId}/bots?${query}`, read);
          if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ProtocolError("Bot inventory page must be an object.");
          const page = value as Record<string, unknown>;
          if (!Array.isArray(page.items) || (page.nextCursor !== null && (typeof page.nextCursor !== "string" || page.nextCursor.length === 0))) throw new ProtocolError("Bot inventory page is malformed.");
          for (const item of page.items) items.push(parseBot(item, owner));
          cursor = page.nextCursor as string | null;
          if (cursor !== null) {
            if (cursors.has(cursor)) throw new ProtocolError("Bot inventory pagination repeated a cursor.");
            cursors.add(cursor);
          }
        } while (cursor !== null);
        read.check();
        return items;
      } finally { read.dispose(); }
    },
    read: async (botId, signal, originalOwner = owner) => {
      botUUID(botId, "Bot ID");
      const original = parseBotOwner(originalOwner);
      if (original.serverOrigin !== owner.serverOrigin || original.ownerUserId !== owner.ownerUserId) throw new Error("Bot detail requires its original service and account.");
      const read = operation(signal);
      try {
        const value = await request(`/api/v1/me/bots/${botId}`, read, true);
        if (value === missing) return null;
        const bot = parseBot(value, original);
        if (bot.id !== botId) throw new ProtocolError("Bot detail identity differs from the requested Bot.");
        return bot;
      } finally { read.dispose(); }
    },
    readDeletionRecovery: async (botId, signal, originalOwner = owner) => {
      botUUID(botId, "Bot ID");
      const original = parseBotOwner(originalOwner);
      if (original.serverOrigin !== owner.serverOrigin || original.ownerUserId !== owner.ownerUserId) throw new Error("Bot recovery requires its original service and account.");
      const read = operation(signal);
      try {
        const value = await request(`/api/v1/me/bots/${botId}/deletion-recovery`, read, false, true);
        // An older service does not expose this sidecar. It never means that the
        // original execution or its deletion responsibility is absent.
        if (value === missing) return null;
        const recovery = parseBotDeletionRecovery(value, botId);
        if (recovery.workerId !== original.workerId) throw new ProtocolError("Bot recovery Worker differs from its original local responsibility.");
        return recovery;
      } finally { read.dispose(); }
    },
  };
};
