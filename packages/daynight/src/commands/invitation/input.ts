import { CliCancelledError } from "../../cli/cancellation.js";

const LIMIT = 4096;

// Read bytes before decoding so the limit also applies to malformed UTF-8.
export const readInvitationLink = async (stdin: boolean, signal: AbortSignal): Promise<string> => {
  const input = process.stdin;
  if (!stdin && (!input.isTTY || !process.stderr.isTTY)) throw new Error("Invitation input requires a terminal or --stdin.");
  signal.throwIfAborted();
  const raw = !stdin;
  const wasRaw = input.isRaw === true;
  if (raw) input.setRawMode(true);
  try {
    if (raw) process.stderr.write("Invitation link (hidden): ");
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      let chunks: Buffer[] = [];
      let size = 0;
      const finish = (error?: Error): void => {
        input.pause(); input.off("data", onData); input.off("end", onEnd); input.off("error", onError); signal.removeEventListener("abort", onAbort);
        if (error) reject(error); else resolve(Buffer.concat(chunks, size));
        chunks = [];
      };
      const onData = (chunk: Buffer | string): void => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (raw) {
          for (const byte of data) {
            if (byte === 3 || byte === 4) { finish(new CliCancelledError()); return; }
            if (byte === 10 || byte === 13) { finish(); return; }
            if (byte === 127 || byte === 8) { if (size > 0) { const all = Buffer.concat(chunks, size).subarray(0, size - 1); chunks = [all]; size--; } continue; }
            if (size === LIMIT) { finish(new Error("Invitation input exceeds 4096 bytes.")); return; }
            chunks.push(Buffer.from([byte])); size++;
          }
        } else {
          size += data.length;
          if (size > LIMIT) { finish(new Error("Invitation input exceeds 4096 bytes.")); return; }
          chunks.push(data);
        }
      };
      const onEnd = (): void => finish();
      const onError = (): void => finish(new Error("Could not read invitation input."));
      const onAbort = (): void => finish(new CliCancelledError());
      input.on("data", onData); input.once("end", onEnd); input.once("error", onError); signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort(); else input.resume();
    });
    let value: string;
    try { value = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error("Invalid invitation input encoding."); }
    return stdin ? value.replace(/\r?\n$/, "") : value;
  } finally {
    if (raw) { input.setRawMode(wasRaw); process.stderr.write("\n"); }
  }
};

export const parseInvitationLink = (value: string, origin: string): { scope: "project" | "team"; token: string } => {
  // URL parsing normalizes whitespace and paths, so enforce the original canonical form.
  try {
    const url = new URL(value);
    const scope = url.pathname === "/invitations" ? "project" : url.pathname === "/team-invitations" ? "team" : undefined;
    const prefix = scope === "project" ? "dninvite_" : "dnteam_";
    const token = url.hash.slice(1);
    const encoded = token.slice(prefix.length);
    if (scope === undefined || url.origin !== origin || url.username || url.password || url.search || value !== `${url.origin}${url.pathname}#${token}` || !token.startsWith(prefix) || !/^[A-Za-z0-9_-]{43}$/.test(encoded) || Buffer.from(encoded, "base64url").toString("base64url") !== encoded) throw new Error();
    return { scope, token };
  } catch { throw new Error("Invalid invitation link; use a same-service Team or Project invitation link."); }
};
