import { expect, test } from "vitest";
import { claudeBackend } from "../../../src/commands/controller/providers/claude-live-profile.js";

test("Claude backend requires actual spawn and resolved settings to agree on the official endpoint", () => {
  expect(claudeBackend({}, {}, undefined, "firstParty")).toBe("anthropic");
  expect(claudeBackend({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" }, {}, undefined, "firstParty")).toBe("anthropic");
  expect(claudeBackend({}, { env: { ANTHROPIC_BASE_URL: "http://localhost:18080" } }, undefined, "firstParty")).toBe("unknown");
  expect(claudeBackend({ ANTHROPIC_BASE_URL: "http://localhost:18080" }, { env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } }, undefined, "firstParty")).toBe("unknown");
  expect(claudeBackend({}, {}, { env: { CLAUDE_CODE_USE_BEDROCK: "1" } }, "firstParty")).toBe("unknown");
  expect(claudeBackend({ CLAUDE_CODE_USE_VERTEX: "true" }, {}, undefined, "vertex")).toBe("vertex");
  expect(claudeBackend({ CLAUDE_CODE_USE_FOUNDRY: "1" }, {}, undefined, "firstParty")).toBe("unknown");
  expect(claudeBackend({}, { policyHelpers: ["resolve-policy"] }, undefined, "firstParty")).toBe("unknown");
  expect(claudeBackend({}, null, undefined)).toBe("unknown");
  expect(claudeBackend({}, {}, "/private/settings.json")).toBe("unknown");
  expect(claudeBackend({ ANTHROPIC_BASE_URL: "https://api.anthropic.com/proxy" }, {}, undefined, "firstParty")).toBe("unknown");
});

test.each(["CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "CLAUDE_CODE_USE_GATEWAY"])("%s cannot inherit first-party qualification from the default endpoint", selector => {
  const official = { ANTHROPIC_BASE_URL: "https://api.anthropic.com" };
  expect(claudeBackend({ [selector]: "1" }, {}, undefined, "firstParty")).toBe("unknown");
  expect(claudeBackend({ ...official, [selector]: "1" }, {}, undefined, "firstParty")).toBe("unknown");
  expect(claudeBackend(official, { env: { [selector]: "true" } }, undefined, "firstParty")).toBe("unknown");
  expect(claudeBackend(official, {}, { env: { [selector]: "1" } }, "firstParty")).toBe("unknown");
  expect(claudeBackend({ ...official, [selector]: "1" }, { env: { [selector]: "0" } }, undefined, "firstParty")).toBe("unknown");
  for (const disabled of [undefined, null, "", "0", "false"]) expect(claudeBackend({ ...official, [selector]: disabled }, {}, undefined, "firstParty")).toBe("anthropic");
});

test("first-party native readback and endpoint configuration must agree", () => {
  const official = { ANTHROPIC_BASE_URL: "https://api.anthropic.com" };
  expect(claudeBackend({}, { env: official }, undefined, "firstParty")).toBe("anthropic");
  expect(claudeBackend(official, { env: { ANTHROPIC_BASE_URL: "" } }, undefined, "firstParty")).toBe("anthropic");
  expect(claudeBackend(official, { env: official }, undefined, "firstParty")).toBe("anthropic");
  expect(claudeBackend({ ...official, CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1" }, {}, undefined, "firstParty")).toBe("unknown");
});


test.each([undefined, null, "", "unknown", "bedrock", "vertex", "foundry", "anthropicAws", "anthropicGoogleCloud", "mantle", "gateway"])("native provider %s cannot qualify a first-party environment", nativeProvider => {
  expect(claudeBackend({}, {}, undefined, nativeProvider)).toBe("unknown");
  expect(claudeBackend({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" }, {}, undefined, nativeProvider)).toBe("unknown");
});

test.each(["win32", "linux"] as const)("%s endpoint checks follow the native environment's name semantics", platform => {
  const proxy = { aNtHrOpIc_BaSe_Url: "http://localhost:18080" }, expected = platform === "win32" ? "unknown" : "anthropic";
  expect(claudeBackend(proxy, {}, undefined, "firstParty", platform)).toBe(expected);
  expect(claudeBackend({}, { env: proxy }, undefined, "firstParty", platform)).toBe(expected);
  expect(claudeBackend({}, {}, { env: proxy }, "firstParty", platform)).toBe(expected);
  expect(claudeBackend({ anthropic_base_url: "https://api.anthropic.com" }, {}, undefined, "firstParty", platform)).toBe("anthropic");
});

test.each(["CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "CLAUDE_CODE_USE_GATEWAY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"])("Windows recognizes mixed-case %s in every environment layer", selector => {
  const environment = { [selector.toLowerCase()]: "1" };
  expect(claudeBackend(environment, {}, undefined, "firstParty", "win32")).toBe("unknown");
  expect(claudeBackend({}, { env: environment }, undefined, "firstParty", "win32")).toBe("unknown");
  expect(claudeBackend({}, {}, { env: environment }, "firstParty", "win32")).toBe("unknown");
  expect(claudeBackend(environment, {}, undefined, "firstParty", "linux")).toBe("anthropic");
});

test("Windows rejects ambiguous case variants after the original environment merge", () => {
  const official = { ANTHROPIC_BASE_URL: "https://api.anthropic.com" }, duplicate = { anthropic_base_url: "https://api.anthropic.com" };
  expect(claudeBackend({ ...official, ...duplicate }, {}, undefined, "firstParty", "win32")).toBe("unknown");
  expect(claudeBackend(official, { env: duplicate }, undefined, "firstParty", "win32")).toBe("unknown");
  expect(claudeBackend(official, {}, { env: duplicate }, "firstParty", "win32")).toBe("unknown");
  expect(claudeBackend({}, { env: official }, { env: duplicate }, "firstParty", "win32")).toBe("unknown");
  expect(claudeBackend({ claude_code_use_mantle: "0" }, { env: { CLAUDE_CODE_USE_MANTLE: "false" } }, undefined, "firstParty", "win32")).toBe("unknown");
  expect(claudeBackend(official, { env: official }, { env: official }, "firstParty", "win32")).toBe("anthropic");
  expect(claudeBackend({ ANTHROPIC_BASE_URL: "http://localhost:18080", ...duplicate }, {}, undefined, "firstParty", "win32")).toBe("unknown");
});
