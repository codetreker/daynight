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
