import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { claudeBackend as nativeClaudeBackend, claudeProfileEndpoint, claudeGlobalEnvironment } from "../../../src/commands/controller/providers/claude-live-profile.js";

// Pure classifier cases supply global evidence instead of reading machine config.
const claudeBackend: typeof nativeClaudeBackend = (...args) => { args[6] ??= () => ({}); return nativeClaudeBackend(...args); };

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

test.each(["linux", "win32"] as const)("%s socket transport cannot inherit first-party endpoint qualification", platform => {
  const official = { ANTHROPIC_BASE_URL: "https://api.anthropic.com" };
  for (const socket of ["/private/model.sock", "0", "false"]) {
    expect(claudeBackend({ ...official, ANTHROPIC_UNIX_SOCKET: socket }, {}, undefined, "firstParty", platform)).toBe("unknown");
    expect(claudeBackend(official, { env: { ANTHROPIC_UNIX_SOCKET: socket } }, undefined, "firstParty", platform)).toBe("unknown");
    expect(claudeBackend(official, {}, { env: { ANTHROPIC_UNIX_SOCKET: socket } }, "firstParty", platform)).toBe("unknown");
    expect(claudeBackend({ ...official, ANTHROPIC_UNIX_SOCKET: socket }, { env: { ANTHROPIC_UNIX_SOCKET: "" } }, undefined, "firstParty", platform)).toBe("unknown");
  }
  for (const absent of [undefined, null, ""]) expect(claudeBackend({ ...official, ANTHROPIC_UNIX_SOCKET: absent }, {}, undefined, "firstParty", platform)).toBe("anthropic");
});

test.each(["linux", "win32"] as const)("%s socket names follow native environment casing", platform => {
  const socket = { aNtHrOpIc_UnIx_SoCkEt: "0" }, expected = platform === "win32" ? "unknown" : "anthropic";
  expect(claudeBackend(socket, {}, undefined, "firstParty", platform)).toBe(expected);
  expect(claudeBackend({}, { env: socket }, undefined, "firstParty", platform)).toBe(expected);
  expect(claudeBackend({}, {}, { env: socket }, "firstParty", platform)).toBe(expected);
});

test("Windows socket case variants cannot disappear through layer normalization", () => {
  const upper = { ANTHROPIC_UNIX_SOCKET: "" }, lower = { anthropic_unix_socket: "" };
  expect(claudeBackend({ ...upper, ...lower }, {}, undefined, "firstParty", "win32")).toBe("unknown");
  expect(claudeBackend(upper, { env: lower }, undefined, "firstParty", "win32")).toBe("unknown");
  expect(claudeBackend(upper, {}, { env: lower }, "firstParty", "win32")).toBe("unknown");
  expect(claudeBackend({}, { env: upper }, { env: lower }, "firstParty", "win32")).toBe("unknown");
  expect(claudeBackend(upper, { env: upper }, { env: upper }, "firstParty", "win32")).toBe("anthropic");
});


test.each(["linux", "win32"] as const)("%s resolves explicit, active and default profile endpoints without credentials", platform => {
  const join = (...parts: string[]) => parts.join(platform === "win32" ? "\\" : "/");
  const directory = platform === "win32" ? "C:\\profiles" : "/profiles";
  for (const authentication of ["oidc_federation", "user_oauth"]) {
    for (const selectedProfile of ["explicit", "active", "default"]) {
      const files = new Map<string, string>();
      const environment = { ANTHROPIC_CONFIG_DIR: directory, ...(selectedProfile === "explicit" ? { ANTHROPIC_PROFILE: "chosen" } : {}) };
      if (selectedProfile === "active") files.set(join(directory, "active_config"), "chosen\n");
      const path = join(directory, "configs", selectedProfile === "default" ? "default.json" : "chosen.json");
      const reads: string[] = [];
      const resolve = (env: Record<string, unknown>, os: NodeJS.Platform) => claudeProfileEndpoint(env, os, file => { reads.push(file); return files.get(file) ?? null; });
      files.set(path, JSON.stringify({ authentication: { type: authentication }, base_url: "http://localhost:18080" }));
      expect(claudeBackend(environment, {}, undefined, "firstParty", platform, resolve)).toBe("unknown");
      expect(claudeBackend({}, { env: environment }, undefined, "firstParty", platform, resolve)).toBe("unknown");
      expect(claudeBackend({}, {}, { env: environment }, "firstParty", platform, resolve)).toBe("unknown");
      expect(claudeBackend({ ...environment, ANTHROPIC_BASE_URL: "https://api.anthropic.com" }, {}, undefined, "firstParty", platform, resolve)).toBe("anthropic");
      files.set(path, JSON.stringify({ authentication: { type: authentication }, base_url: "https://api.anthropic.com" }));
      expect(claudeBackend(environment, {}, undefined, "firstParty", platform, resolve)).toBe("anthropic");
      expect(reads.every(file => !file.includes("credentials"))).toBe(true);
    }
  }
});

test("profile resolution follows platform defaults and federation precedence", () => {
  const cases = [
    ["linux", { HOME: "/home/test" }, "/home/test/.config/anthropic/configs/default.json"],
    ["linux", { HOME: "/home/test", XDG_CONFIG_HOME: "/config" }, "/config/anthropic/configs/default.json"],
    ["win32", { APPDATA: "C:/AppData" }, "C:\\AppData\\Anthropic\\configs\\default.json"],
    ["win32", { USERPROFILE: "C:/Users/test" }, "C:\\Users\\test\\AppData\\Roaming\\Anthropic\\configs\\default.json"],
  ] as const;
  for (const [platform, environment, expected] of cases) {
    const reads: string[] = [];
    expect(claudeProfileEndpoint(environment, platform, path => { reads.push(path); return null; })).toBe(true);
    expect(reads).toContain(expected);
  }
  const environment = { ANTHROPIC_CONFIG_DIR: "/profiles", ANTHROPIC_FEDERATION_RULE_ID: " rule ", ANTHROPIC_ORGANIZATION_ID: "org" };
  const failRead = () => { throw new Error("must not read implicit profile"); };
  expect(claudeProfileEndpoint(environment, "linux", failRead)).toBe(true);
  expect(claudeProfileEndpoint({ ...environment, ANTHROPIC_PROFILE: "chosen" }, "linux", failRead)).toBe(false);
  const customDefault = (path: string) => path.endsWith(".json") ? JSON.stringify({ authentication: { type: "oidc_federation" }, base_url: "http://localhost:18080" }) : null;
  for (const missing of ["ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID"]) {
    expect(claudeProfileEndpoint({ ...environment, [missing]: " " }, "linux", customDefault)).toBe(false);
  }
});

test("profile absence is allowed but malformed, inaccessible and unknown configuration fails closed", () => {
  const environment = { ANTHROPIC_CONFIG_DIR: "/profiles" };
  expect(claudeProfileEndpoint(environment, "linux", () => null)).toBe(true);
  for (const source of ["{", "{}", JSON.stringify({ authentication: { type: "future" } })]) {
    expect(claudeProfileEndpoint(environment, "linux", path => path.endsWith(".json") ? source : null)).toBe(false);
  }
  expect(claudeProfileEndpoint(environment, "linux", () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); })).toBe(false);
});

test("Windows profile selection preserves case ambiguity across environment merges", () => {
  const proxyProfile = (env: Record<string, unknown>, platform: NodeJS.Platform) => claudeProfileEndpoint(env, platform, path => path.endsWith(".json") ? JSON.stringify({ authentication: { type: "oidc_federation" }, base_url: "http://localhost:18080" }) : null);
  expect(claudeBackend({ anthropic_config_dir: "C:/profiles" }, {}, undefined, "firstParty", "win32", proxyProfile)).toBe("unknown");
  for (const key of ["ANTHROPIC_CONFIG_DIR", "ANTHROPIC_PROFILE", "APPDATA", "USERPROFILE", "HOME", "XDG_CONFIG_HOME", "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID"]) {
    expect(claudeBackend({ [key]: "" }, { env: { [key.toLowerCase()]: "" } }, undefined, "firstParty", "win32", proxyProfile)).toBe("unknown");
  }
});

test("relative profile directories cannot borrow the helper working directory", () => {
  for (const platform of ["linux", "win32"] as const) expect(claudeProfileEndpoint({ ANTHROPIC_CONFIG_DIR: "relative" }, platform, () => { throw new Error("must not read"); })).toBe(false);
});

test("native profile discovery has no home-directory fallback outside its environment", () => {
  const noRead = () => { throw new Error("must not inspect a machine home directory"); };
  for (const platform of ["linux", "win32"] as const) {
    expect(claudeProfileEndpoint({}, platform, noRead)).toBe(true);
    expect(claudeProfileEndpoint({ ANTHROPIC_PROFILE: "chosen" }, platform, noRead)).toBe(false);
  }
});


test.each(["linux", "win32"] as const)("%s global env participates in every backend capability check", platform => {
  const root = platform === "win32" ? "C:\\home" : "/home";
  const homeKey = platform === "win32" ? "USERPROFILE" : "HOME";
  const environment = { [homeKey]: root };
  for (const injected of [
    { ANTHROPIC_UNIX_SOCKET: "false" }, { ANTHROPIC_BASE_URL: "http://localhost:18080" },
    { CLAUDE_CODE_USE_MANTLE: "1" }, { ANTHROPIC_CONFIG_DIR: root, ANTHROPIC_PROFILE: "redirected" },
    { CLAUDE_CODE_HOST_CREDS_FILE: "private-host-input" }, { CLAUDE_CODE_CUSTOM_OAUTH_URL: "https://claude.fedstart.com" },
  ]) {
    const global = (env: Record<string, unknown>, os: NodeJS.Platform) => claudeGlobalEnvironment(env, os, file => file.endsWith(".claude.json") ? JSON.stringify({ env: injected, ignored: "private field" }) : null);
    const profile = (env: Record<string, unknown>) => env.ANTHROPIC_PROFILE !== "redirected";
    expect(nativeClaudeBackend(environment, {}, undefined, "firstParty", platform, profile, global)).toBe("unknown");
    expect(nativeClaudeBackend(environment, { env: { ANTHROPIC_UNIX_SOCKET: "", ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_PROFILE: "" } }, undefined, "firstParty", platform, profile, global)).toBe("unknown");
  }
});

test("global configuration anchors legacy, custom directory and OAuth suffix selection before merging env", () => {
  const reads: string[] = [];
  const files = new Map<string, string>([["/config/.config.json", JSON.stringify({ env: { HOME: "/redirected", ANTHROPIC_UNIX_SOCKET: "0", SECRET_UNRELATED: "discard" } })], ["/config/.claude.json", JSON.stringify({ env: {} })]]);
  const read = (file: string) => { reads.push(file); return files.get(file) ?? null; };
  expect(JSON.stringify(claudeGlobalEnvironment({ HOME: "/home", CLAUDE_CONFIG_DIR: "/config" }, "linux", read))).toBe(JSON.stringify({ HOME: "/redirected", ANTHROPIC_UNIX_SOCKET: "0" }));
  expect(JSON.stringify(reads)).toBe(JSON.stringify(["/config/.config.json"]));
  files.delete("/config/.config.json"); reads.length = 0;
  claudeGlobalEnvironment({ HOME: "/home", CLAUDE_CONFIG_DIR: "/config", CLAUDE_CODE_CUSTOM_OAUTH_URL: "https://claude.fedstart.com" }, "linux", read);
  expect(reads).toContain("/config/.claude-custom-oauth.json");
  reads.length = 0;
  claudeGlobalEnvironment({}, "linux", read, () => "/system-home");
  expect(reads).toContain("/system-home/.claude/.config.json");
  expect(reads).toContain("/system-home/.claude.json");
});

test("global configuration fails closed for unreadable paths, malformed env and Windows ambiguous names", () => {
  for (const source of ["{", JSON.stringify({ env: [] }), JSON.stringify({ env: { ANTHROPIC_UNIX_SOCKET: 0 } })]) {
    expect(claudeGlobalEnvironment({ HOME: "/home" }, "linux", () => source)).toBe(null);
  }
  expect(claudeGlobalEnvironment({ HOME: "/home" }, "linux", () => { throw new Error("denied"); })).toBe(null);
  expect(claudeGlobalEnvironment({ CLAUDE_CONFIG_DIR: "relative" }, "linux", () => null)).toBe(null);
  expect(claudeGlobalEnvironment({ CLAUDE_CONFIG_DIR: "C:/config", claude_config_dir: "C:/config" }, "win32", () => null)).toBe(null);
  const global = () => ({ anthropic_unix_socket: "", ANTHROPIC_UNIX_SOCKET: "" });
  expect(nativeClaudeBackend({ USERPROFILE: "C:/home" }, {}, undefined, "firstParty", "win32", () => true, global)).toBe("unknown");
});


test("the default production resolver rejects a socket configured only in the isolated native global file", () => {
  const scratch = join(process.cwd(), ".tmp");
  mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(join(scratch, "claude-global-"));
  const environment = process.platform === "win32" ? { USERPROFILE: home } : { HOME: home };
  try {
    expect(nativeClaudeBackend(environment, {}, undefined, "firstParty")).toBe("anthropic");
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ env: { ANTHROPIC_UNIX_SOCKET: "false" } }));
    const before = JSON.stringify(environment);
    expect(nativeClaudeBackend(environment, {}, undefined, "firstParty")).toBe("unknown");
    expect(JSON.stringify(environment)).toBe(before);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("flag env cannot erase a resolved managed endpoint override", () => {
  expect(claudeBackend({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" }, { env: { ANTHROPIC_BASE_URL: "http://localhost:18080" } }, { env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } }, "firstParty")).toBe("unknown");
});
