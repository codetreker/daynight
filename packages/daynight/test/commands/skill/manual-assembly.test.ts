import { describe, expect, it } from "vitest";
import { assembleManual } from "../../../src/commands/skill/manual-assembly.js";
import { manualTopicFiles } from "../../../src/commands/skill/manual.js";
import { manualTopicSources } from "../../fixtures/manual-topics.js";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("complete CLI manual assembly", () => {
  it("preserves every topic in manifest order and resolves file, fragment and local links to distinct aggregate anchors", () => {
    const sources = manualTopicSources();
    sources.set(manualTopicFiles[0], encode("# Setup\n\n[Tasks](tasks.md) and [Shared](tasks.md#shared), [here](#shared), [web](https://daynight.cc/setup).\n\n## Shared\n\nSetup details.\n"));
    sources.set(manualTopicFiles[1], encode("# Tasks\n\n## Shared\n\nTask details.\n"));
    const manual = decode(assembleManual(sources));
    expect(manual).toContain("name: daynight\n");
    expect(manual).toContain('[Tasks](#tasks--tasks) and [Shared](#tasks--shared), [here](#setup-and-projects--shared), [web](https://daynight.cc/setup).');
    expect(manual).toContain('<a id="setup-and-projects--shared"></a>\n### Shared');
    expect(manual).toContain('<a id="tasks--shared"></a>\n### Shared');
    expect(manual.indexOf("Setup details.")).toBeLessThan(manual.indexOf("Task details."));
    for (let index = 2; index < manualTopicFiles.length; index++) expect(manual).toContain(`## Topic ${index + 1}\n`);
  });

  it("leaves code examples and their link-like strings unchanged, including nested shorter fence markers", () => {
    const sources = manualTopicSources();
    sources.set(manualTopicFiles[0], encode("# Setup\n\n````markdown\n# Example\n[example](missing.md#missing)\n```\n````\n\n[Tasks](tasks.md)\n"));
    const manual = decode(assembleManual(sources));
    expect(manual).toContain("````markdown\n# Example\n[example](missing.md#missing)\n```\n````");
    expect(manual).toContain("[Tasks](#tasks--topic-2)");
  });

  it("normalizes source line endings without changing the source buffers", () => {
    const lf = manualTopicSources();
    const crlf = new Map([...lf].map(([filename, contents]) => [filename, encode(decode(contents).replaceAll("\n", "\r\n"))]));
    expect(assembleManual(crlf)).toEqual(assembleManual(lf));
    expect(decode(crlf.get(manualTopicFiles[0])!)).toContain("\r\n");
  });

  it("requires every topic", () => {
    const sources = manualTopicSources();
    sources.delete(manualTopicFiles[3]);
    expect(() => assembleManual(sources)).toThrow(`Missing manual topic: ${manualTopicFiles[3]}`);
  });

  it.each([
    { name: "empty", contents: encode("") },
    { name: "Unicode whitespace", contents: encode("\u0085\u2000") },
    { name: "invalid UTF-8", contents: new Uint8Array([0xff]) },
    { name: "missing title", contents: encode("## Setup\n") },
    { name: "multiple titles", contents: encode("# Setup\n# Another\n") },
    { name: "duplicate heading", contents: encode("# Setup\n## Details\n## Details\n") },
    { name: "unknown document", contents: encode("# Setup\n[Unknown](missing.md)\n") },
    { name: "unknown heading", contents: encode("# Setup\n[Unknown](tasks.md#missing)\n") },
    { name: "outside resource", contents: encode("# Setup\n[Outside](../../AGENTS.md)\n") },
    { name: "unclosed fence", contents: encode("# Setup\n```bash\ncommand\n") },
  ])("rejects $name sources before producing an aggregate", ({ contents }) => {
    const sources = manualTopicSources();
    sources.set(manualTopicFiles[0], contents);
    expect(() => assembleManual(sources)).toThrow();
  });
});
