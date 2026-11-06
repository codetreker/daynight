import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

type ObjectValue = Record<string, any>;
type Input = {
  endpoint: string;
  token: string;
  team: string;
  member: string;
  want: Record<string, Record<string, Record<string, string | null>>>;
};

const root = process.env.DAYNIGHT_MCP_TYPESCRIPT_SDK_ROOT;
assert.ok(root, "DAYNIGHT_MCP_TYPESCRIPT_SDK_ROOT is required");
const sdkRequire = createRequire(join(root, "package.json"));
const { Client } = sdkRequire("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = sdkRequire(
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
);
const sdkPackage = JSON.parse(
  await readFile(join(root, "node_modules/@modelcontextprotocol/sdk/package.json"), "utf8"),
);
assert.equal(sdkPackage.version, "1.32.2", "install the pinned official SDK");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const incoming = lines[Symbol.asyncIterator]();
const readInput = async (): Promise<ObjectValue> => {
  const line = await incoming.next();
  assert.equal(line.done, false, "server-side fixture ended before its response");
  return JSON.parse(line.value);
};
const input = (await readInput()) as Input;
const client = new Client({ name: "daynight-team-item-acceptance", version: "1" });
const transport = new StreamableHTTPClientTransport(new URL(input.endpoint), {
  requestInit: { headers: { Authorization: `Bearer ${input.token}` } },
});
let calls = 0;
let byteCount = 0;
const decimal = (value: unknown): number => {
  assert.equal(typeof value, "string");
  assert.match(value as string, /^(0|[1-9][0-9]*)$/);
  const n = Number(value);
  assert.ok(Number.isSafeInteger(n));
  return n;
};
const call = async (
  name: string,
  args: ObjectValue,
  expectedError?: string,
): Promise<ObjectValue> => {
  const result = await client.callTool({ name, arguments: args });
  calls++;
  assert.equal(result.content.length, 1, `${name}: text envelope is missing`);
  assert.equal(result.content[0].type, "text");
  const envelope = JSON.parse(result.content[0].text);
  assert.deepEqual(envelope, result.structuredContent, `${name}: text/structured parity`);
  assert.equal(Boolean(result.isError), envelope.error !== undefined);
  assert.equal(envelope.error?.code, expectedError);
  assert.equal(envelope.error?.writeOutcome, undefined, "reads cannot return writeOutcome");
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16 * 1024, `${name}: default result budget`);
  return envelope;
};
const identity = (kind: string, value: ObjectValue): string =>
  kind === "member" ? value.userId : value.id;

try {
  await client.connect(transport);
  assert.equal(transport.protocolVersion, "2025-11-25");
  const definitions = await client.listTools();
  const tools = new Map(definitions.tools.map((tool: ObjectValue) => [tool.name, tool]));
  for (const name of ["team_list", "team_member_list", "team_projects", "team_item_read"]) {
    assert.ok(tools.has(name), `${name}: tool discovery`);
    assert.equal((tools.get(name) as ObjectValue).inputSchema.type, "object");
    assert.equal((tools.get(name) as ObjectValue).outputSchema.type, "object");
  }
  for (const [kind, tool] of [["team", "team_list"], ["member", "team_member_list"], ["project", "team_projects"]]) {
    const seen = new Set<string>();
    let cursor: string | null = null;
    let boundaries = 0;
    let ended = false;
    const expected = input.want[kind];
    for (let pages = 0; pages < Object.keys(expected).length * 3; pages++) {
      const args: ObjectValue = { limit: 100 };
      if (kind !== "team") args.team = input.team;
      if (cursor !== null) args.cursor = cursor;
      const result = await client.callTool({ name: tool, arguments: args });
      const code = result.isError ? "payload_too_large" : undefined;
      const envelope = JSON.parse(result.content[0].text);
      calls++;
      assert.deepEqual(envelope, result.structuredContent);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16 * 1024);
      assert.equal(envelope.error?.code, code);
      assert.equal(envelope.error?.writeOutcome, undefined);
      if (code) {
        const refs = envelope.error.refs;
        assert.equal(refs.readTool, "team_item_read");
        const read = refs.readArguments;
        assert.equal(read.kind, kind);
        assert.equal(read.action, "inspect");
        const data = (await call(refs.readTool, read)).data;
        assert.equal(data.projection, "metadata");
        assert.equal(data.contentIncluded, false);
        const id = identity(kind, data.header);
        assert.ok(expected[id] && !seen.has(id), `${kind}: duplicate or foreign boundary`);
        assert.equal(data.fields.length, Object.keys(expected[id]).length);
        for (const field of data.fields) {
          assert.ok(Object.hasOwn(expected[id], field.field));
          const value = expected[id][field.field];
          assert.equal(field.isNull, value === null);
          const size = value === null ? 0 : Buffer.byteLength(value);
          assert.equal(decimal(field.sizeBytes), size);
          if (value === null) continue;
          const chunks: Buffer[] = [];
          let offset = "0";
          for (let n = 0; n <= size + 1; n++) {
            const chunkArgs = { ...read, action: "chunk", revision: data.revision, field: field.field, offset };
            const chunk = (await call("team_item_read", chunkArgs)).data;
            assert.equal(chunk.revision, data.revision);
            assert.equal(chunk.field, field.field);
            assert.equal(chunk.offset, offset);
            assert.equal(chunk.encoding, "utf8");
            const bytes = Buffer.from(chunk.text, "utf8");
            const next = decimal(offset) + bytes.length;
            assert.equal(decimal(chunk.readBytes), bytes.length);
            assert.equal(decimal(chunk.nextOffset), next);
            assert.equal(decimal(chunk.sizeBytes), size);
            assert.equal(chunk.eof, next === size);
            assert.ok(bytes.length > 0 || chunk.eof, "nonterminal chunk must progress");
            chunks.push(bytes);
            offset = chunk.nextOffset;
            if (chunk.eof) break;
          }
          assert.equal(decimal(offset), size, "field must terminate");
          assert.deepEqual(Buffer.concat(chunks), Buffer.from(value), "UTF-8 byte reconstruction");
          byteCount += size;
          const eof = (await call("team_item_read", { ...read, action: "chunk", revision: data.revision, field: field.field, offset })).data;
          assert.equal(eof.eof, true);
          assert.equal(eof.readBytes, "0");
          assert.equal(eof.nextOffset, offset);
          const binary = (await call("team_item_read", { ...read, action: "chunk", revision: data.revision, field: field.field, offset: "1", maxBytes: 17, format: "base64" }, size > 0 ? undefined : "invalid_input"));
          if (size > 0) {
            assert.equal(binary.data.encoding, "base64");
            assert.deepEqual(Buffer.from(binary.data.contentBase64, "base64"), Buffer.from(value).subarray(1, 18));
          }
        }
        seen.add(id);
        boundaries++;
        assert.equal(typeof refs.cursorAfterItem, "string");
        assert.notEqual(refs.cursorAfterItem, cursor);
        cursor = refs.cursorAfterItem;
        continue;
      }
      for (const item of envelope.data.items) {
        const id = identity(kind, item);
        assert.ok(expected[id] && !seen.has(id), `${kind}: duplicate or foreign inline item`);
        for (const [field, value] of Object.entries(expected[id])) {
          const actual = kind === "member" ? item.profile[field.slice("profile.".length)] : item[field];
          assert.equal(actual, value, `${kind}: inline field parity`);
        }
        seen.add(id);
      }
      if (envelope.data.nextCursor === null) {
        ended = true;
        break;
      }
      assert.notEqual(envelope.data.nextCursor, cursor);
      cursor = envelope.data.nextCursor;
    }
    assert.ok(ended, `${kind}: directory must terminate`);
    assert.deepEqual([...seen].sort(), Object.keys(expected).sort(), `${kind}: exact directory membership`);
    assert.equal(boundaries, 1, `${kind}: expected oversized boundary`);
  }
  const read = { kind: "member", team: input.team, userId: input.member, action: "inspect" };
  const before = (await call("team_item_read", read)).data;
  await call("team_item_read", { ...read, action: "chunk", revision: before.revision, field: "profile.name", offset: "0" });
  console.log("MCP_TS_MUTATE");
  assert.equal((await readInput()).continue, true);
  await call("team_item_read", { ...read, action: "chunk", revision: before.revision, field: "profile.name", offset: "0" }, "version_conflict");
  const after = (await call("team_item_read", read)).data;
  assert.notEqual(after.revision, before.revision, "same-timestamp write must invalidate revision");
  console.log(`MCP_TS_COMPLETE ${JSON.stringify({ sdkVersion: sdkPackage.version, protocol: transport.protocolVersion, kinds: 3, oversizedItems: 3, calls, reconstructedBytes: byteCount, timestampConflict: true, textOnlyReconstruction: true })}`);
} finally {
  await client.close();
  lines.close();
  process.stdin.destroy();
}
