import { expect, test } from "vitest";
import { claudeBackend } from "../../../src/commands/controller/providers/claude-live-profile.js";

test("Claude backend requires actual spawn and resolved settings to agree on the official endpoint", () => {
  expect(claudeBackend({}, {}, undefined)).toBe("anthropic");
  expect(claudeBackend({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" }, {}, undefined)).toBe("anthropic");
  expect(claudeBackend({}, { env: { ANTHROPIC_BASE_URL: "http://localhost:18080" } }, undefined)).toBe("unknown");
  expect(claudeBackend({ ANTHROPIC_BASE_URL: "http://localhost:18080" }, { env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } }, undefined)).toBe("unknown");
  expect(claudeBackend({}, {}, { env: { CLAUDE_CODE_USE_BEDROCK: "1" } })).toBe("unknown");
  expect(claudeBackend({ CLAUDE_CODE_USE_VERTEX: "true" }, {}, undefined)).toBe("vertex");
  expect(claudeBackend({ CLAUDE_CODE_USE_FOUNDRY: "1" }, {}, undefined)).toBe("unknown");
  expect(claudeBackend({}, { policyHelpers: ["resolve-policy"] }, undefined)).toBe("unknown");
  expect(claudeBackend({}, null, undefined)).toBe("unknown");
  expect(claudeBackend({}, {}, "/private/settings.json")).toBe("unknown");
  expect(claudeBackend({ ANTHROPIC_BASE_URL: "https://api.anthropic.com/proxy" }, {}, undefined)).toBe("unknown");
});
