import { directAccessFixture } from "./helpers/taskSync";
import { stringifyWireJson } from "./helpers/wireJson";
import { describe, expect, it, vi } from "vitest";
import {
  decodeAuthJson, decodeInvitationJson, decodeMembersJson, parseAuthConfig, parseCreatedInvitation, parseCreatedToken, parseInvitation,
  parseInvitationInspection, parseInvitations, parseMember, parseMembers, parseMemberVersion,
  parseRole, parseToken, parseTokens, parseUser,
} from "../src/api/auth-parse";

const projectId = "10000000-0000-0000-0000-00000000000a";
const userId = "20000000-0000-0000-0000-00000000000b";
const otherId = "30000000-0000-0000-0000-00000000000c";
const tokenId = "40000000-0000-0000-0000-00000000000d";
const invitationId = "50000000-0000-0000-0000-00000000000e";
const time = "2026-10-20T12:34:56.123456789Z";
const expiresAt = "2026-11-20T12:34:56Z";
const user = { personalTeam: { id: '00000000-0000-4000-8000-000000000701', kind: 'personal' as const, name: null }, id: userId, email: null, emailVerified: null, name: null, avatarUrl: null };
const token = { id: tokenId, name: "CLI access", createdAt: time, expiresAt, lastUsedAt: time };
const member = { projectId, userId, email: null, name: null, avatarUrl: null, role: "member", version: 1n, createdAt: time, updatedAt: time };
const grant = { projectId, userId, role: member.role, version: member.version, createdAt: time, updatedAt: time };
const participant = { inheritedFrom: null, userId, profile: { name: null, email: null, avatarUrl: null }, effectiveRole: member.role, directGrant: grant };
const participantJson = (version: string) => `{"userId":"${userId}","inheritedFrom":null,"profile":{"name":null,"email":null,"avatarUrl":null},"effectiveRole":"member","directGrant":{"projectId":"${projectId}","userId":"${userId}","role":"member","version":${version},"createdAt":"${time}","updatedAt":"${time}"}}`;
const inspectionJson = (version: string) => {
  const directGrant = { ...grant, version: BigInt(version) };
  return stringifyWireJson({ projectId, projectName: "Project", directGrant, access: { ...directAccessFixture(projectId, userId), directGrant } });
};
const invitation = { id: invitationId, projectId, createdBy: userId, createdAt: time, expiresAt, consumedBy: null, consumedAt: null, revokedAt: null };
const memberJson = (version: string) => `{"projectId":"${projectId}","userId":"${userId}","email":null,"name":null,"avatarUrl":null,"role":"member","version":${version},"createdAt":"${time}","updatedAt":"${time}"}`;

describe("authentication configuration and user parsing", () => {
  it("accepts an empty provider list and the complete configured provider enum in server order", () => {
    expect(parseAuthConfig({ providers: [] })).toEqual({ providers: [] });
    expect(parseAuthConfig({ providers: ["github", "microsoft", "google"] })).toEqual({ providers: ["github", "microsoft", "google"] });
  });

  it.each([
    undefined, null, [], {}, { providers: null }, { providers: "github" },
    { providers: ["github", "github"] }, { providers: ["GitHub"] }, { providers: ["oidc"] }, { providers: [null] },
  ])("rejects a malformed or duplicate provider configuration %#", (value) => {
    expect(() => parseAuthConfig(value)).toThrow("invalid response");
  });

  it("retains explicit nullable profile fields and the false email verification observation", () => {
    expect(parseUser(user)).toEqual(user);
    const profile = { ...user, id: userId.toUpperCase(), email: "", emailVerified: false, name: "", avatarUrl: "" };
    expect(parseUser(profile)).toEqual({ ...profile, id: userId });
    expect(parseUser({ ...user, email: "person@example.com", emailVerified: true, name: "A Person", avatarUrl: "https://example.com/avatar" }))
      .toMatchObject({ personalTeam: { id: '00000000-0000-4000-8000-000000000701', kind: 'personal' as const, name: null }, emailVerified: true, name: "A Person" });
  });

  it.each([
    undefined, null, [], {}, { ...user, id: "not-an-id" },
    ...["id", "email", "emailVerified", "name", "avatarUrl"].map((field) => ({ ...user, [field]: undefined })),
    ...["email", "name", "avatarUrl"].map((field) => ({ ...user, [field]: false })),
    { ...user, emailVerified: "false" }, { ...user, emailVerified: 0 },
  ])("rejects missing and incorrectly typed user fields %#", (value) => {
    expect(() => parseUser(value)).toThrow("invalid response");
  });
});

describe("personal access token parsing", () => {
  it("returns only public token metadata from individual and list responses", () => {
    const value = { ...token, id: tokenId.toUpperCase(), token: "private-token", tokenHash: "private-hash", futureField: true };
    expect(parseToken(value)).toEqual(token);
    expect(parseTokens({ items: [value, { ...value, id: otherId }] })).toEqual([token, { ...token, id: otherId }]);
    expect(parseTokens({ items: [] })).toEqual([]);
    expect(parseToken({ ...token, expiresAt: null })).toEqual({ ...token, expiresAt: null });
    expect(parseToken({ ...token, lastUsedAt: null })).toEqual({ ...token, lastUsedAt: null });
    expect(parseCreatedToken({ ...token, expiresAt: null, token: "permanent-token" })).toEqual({ ...token, expiresAt: null, token: "permanent-token" });
  });

  it("returns a creation secret unchanged while discarding unrelated secret fields", () => {
    const secret = Array.from({ length: 94 }, (_, index) => String.fromCharCode(index + 0x21)).join("");
    expect(parseCreatedToken({ ...token, token: secret, tokenHash: "private-hash" })).toEqual({ ...token, token: secret });
  });

  it.each([
    undefined, null, [], {}, { items: null }, { items: [token, { ...token, id: tokenId.toUpperCase() }] },
    ...["id", "name", "createdAt", "expiresAt", "lastUsedAt"].map((field) => ({ items: [{ ...token, [field]: undefined }] })),
    { items: [{ ...token, name: " " }] }, { items: [{ ...token, name: "name\0value" }] },
    { items: [{ ...token, createdAt: "2026-02-30T00:00:00Z" }] },
    { items: [{ ...token, expiresAt: "2026-11-20T12:34:56+01:00" }] },
    { items: [{ ...token, lastUsedAt: "2026-02-30T00:00:00Z" }] },
    { items: [{ ...token, lastUsedAt: "2026-11-20T12:34:56+01:00" }] },
    { items: [{ ...token, lastUsedAt: false }] },
  ])("rejects incomplete, malformed, and duplicate token lists %#", (value) => {
    expect(() => parseTokens(value)).toThrow("invalid response");
  });

  it.each([undefined, null, "", "secret with space", "secret\nvalue", "secret\tvalue", "secret\u007f", "secreté"])("rejects a malformed creation secret without including it in diagnostics %#", (secret) => {
    expect(() => parseCreatedToken({ ...token, token: secret })).toThrowError(/^The server returned an invalid response\.$/);
  });
});

describe("project membership parsing", () => {
  it("parses both roles, nullable profile fields, scoped identities, and full int64 versions", () => {
    expect(parseRole("admin")).toBe("admin");
    expect(parseRole("member")).toBe("member");
    expect(parseMember(member, projectId, userId)).toEqual(member);
    const admin = { ...member, projectId: projectId.toUpperCase(), userId: userId.toUpperCase(), email: "", name: "Admin", avatarUrl: "", role: "admin", version: 9_223_372_036_854_775_807n };
    expect(parseMember(admin, projectId, userId)).toEqual({ ...admin, projectId, userId });
    expect(parseMembers({ actorAccess: directAccessFixture(projectId, userId), items: [participant, { ...participant, userId: otherId, directGrant: { ...grant, userId: otherId } }] }, projectId).items).toEqual([participant, { ...participant, userId: otherId, directGrant: { ...grant, userId: otherId } }]);
    expect(parseMembers({ actorAccess: directAccessFixture(projectId, userId), items: [] }, projectId).items).toEqual([]);
  });

  it.each([undefined, null, "owner", "Admin", "", 1])("rejects an unsupported member role %#", (role) => {
    expect(() => parseRole(role)).toThrow("invalid response");
  });

  it("accepts only bigint member version observations within positive Go int64 bounds", () => {
    expect(parseMemberVersion(1n)).toBe(1n);
    expect(parseMemberVersion(9_007_199_254_740_993n)).toBe(9_007_199_254_740_993n);
    expect(parseMemberVersion(9_223_372_036_854_775_807n)).toBe(9_223_372_036_854_775_807n);
  });

  it.each([undefined, null, 1, 1.5, NaN, Infinity, "1", true, 0n, -1n, 9_223_372_036_854_775_808n])("rejects a non-bigint or out-of-range member version %#", (version) => {
    expect(() => parseMemberVersion(version)).toThrow("invalid response");
    expect(() => parseMember({ ...member, version }, projectId, userId)).toThrow("invalid response");
  });

  it.each([
    undefined, null, [], {}, { ...member, projectId: "invalid" }, { ...member, userId: null },
    ...["projectId", "userId", "email", "name", "avatarUrl", "role", "version", "createdAt", "updatedAt"].map((field) => ({ ...member, [field]: undefined })),
    ...["email", "name", "avatarUrl"].map((field) => ({ ...member, [field]: false })),
    { ...member, updatedAt: "invalid" },
  ])("rejects a missing or malformed member field %#", (value) => {
    expect(() => parseMember(value)).toThrow("invalid response");
  });

  it("rejects responses scoped to another project or user and canonicalized duplicate members", () => {
    expect(() => parseMember({ ...member, projectId: otherId }, projectId, userId)).toThrow("invalid response");
    expect(() => parseMember({ ...member, userId: otherId }, projectId, userId)).toThrow("invalid response");
    expect(() => parseMembers({ actorAccess: directAccessFixture(projectId, userId), items: [{ ...participant, directGrant: { ...grant, projectId: otherId } }] }, projectId)).toThrow("invalid response");
    expect(() => parseMembers({ actorAccess: directAccessFixture(projectId, userId), items: [participant, { ...participant, userId: userId.toUpperCase() }] }, projectId)).toThrow("invalid response");
    expect(() => parseMembers({}, projectId)).toThrow("invalid response");
  });
});

describe("lossless membership JSON decoding", () => {
  it.each(["1", "9007199254740993", "9223372036854775807"])("decodes the original numeric version lexeme %s without rounding", async (numericVersion) => {
    const decoded = await decodeAuthJson(new Response(memberJson(numericVersion)));
    expect(parseMember(decoded, projectId, userId).version).toBe(BigInt(numericVersion));
  });

  it("decodes nested list and invitation inspection member versions", async () => {
    const list = await decodeMembersJson(new Response(`{"actorAccess":${stringifyWireJson(directAccessFixture(projectId, userId))},"items":[${participantJson("9223372036854775807")}]}`));
    expect(parseMembers(list, projectId).items[0]?.directGrant?.version).toBe(9_223_372_036_854_775_807n);
    const inspection = await decodeInvitationJson(new Response(inspectionJson("9007199254740993")));
    expect(parseInvitationInspection(inspection, userId).directGrant?.version).toBe(9_007_199_254_740_993n);
  });

  it("decodes every membership envelope without requiring reviver context support", async () => {
    const nativeParse = JSON.parse;
    const parse = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => nativeParse(text, reviver === undefined
      ? undefined : function (key, value) { return reviver.call(this, key, value); }));
    try {
      const root = await decodeAuthJson(new Response(memberJson("9223372036854775807")));
      expect(parseMember(root).version).toBe(9_223_372_036_854_775_807n);
      const page = await decodeMembersJson(new Response(`{"actorAccess":${stringifyWireJson(directAccessFixture(projectId, userId))},"items":[${participantJson("9007199254740993")}]}`));
      expect(parseMembers(page, projectId).items[0]?.directGrant?.version).toBe(9_007_199_254_740_993n);
      const inspection = await decodeInvitationJson(new Response(inspectionJson("9223372036854775807")));
      expect(parseInvitationInspection(inspection, userId).directGrant?.version).toBe(9_223_372_036_854_775_807n);
    } finally { parse.mockRestore(); }
  });

  it("uses final escaped envelope keys and preserves native nested container semantics", async () => {
    const page = await decodeMembersJson(new Response(`{"actorAccess":${stringifyWireJson(directAccessFixture(projectId, userId))},"items":{"0":${participantJson("9223372036854775807")}},"\\u0069tems":[${participantJson("1")}]}`));
    expect(parseMembers(page, projectId).items[0]?.directGrant?.version).toBe(1n);
    const source = `{"actorAccess":${stringifyWireJson(directAccessFixture(projectId, userId))},"items":[${participantJson("9223372036854775807")}],"items":{"0":${participantJson("1")}}}`;
    expect(await decodeMembersJson(new Response(source))).toEqual({ ...JSON.parse(source), actorAccess: directAccessFixture(projectId, userId) });
    const inspection = await decodeInvitationJson(new Response(inspectionJson("1")));
    expect(parseInvitationInspection(inspection, userId).directGrant?.version).toBe(1n);
  });

  it.each(["0", "-1", "9223372036854775808", "1.5", "1.0", "1e0", "1E+3", '"1"', "null"])("rejects invalid version lexeme %s after actual JSON decoding", async (numericVersion) => {
    const decoded = await decodeAuthJson(new Response(memberJson(numericVersion)));
    expect(() => parseMember(decoded, projectId, userId)).toThrow("invalid response");
  });

  it("keeps unrelated numbers and strings as JSON values and exposes malformed JSON", async () => {
    await expect(decodeAuthJson(new Response('{"count":2,"name":"unchanged","nested":{"version":1}}')))
      .resolves.toEqual({ count: 2, name: "unchanged", nested: { version: 1 } });
    await expect(decodeAuthJson(new Response('{"version":'))).rejects.toBeInstanceOf(SyntaxError);
  });
});

describe("participant roster contract", () => {
  it("keeps independent effective and stored roles and explicit nullable profiles/grants", () => {
    const value = { ...participant, inheritedFrom: { team: user.personalTeam, role: "admin" }, effectiveRole: "admin", directGrant: { ...grant, role: "member" } };
    expect(parseMembers({ actorAccess: directAccessFixture(projectId, userId), items: [value] }, projectId).items[0]).toEqual(value);
    expect(parseMembers({ actorAccess: directAccessFixture(projectId, userId), items: [{ ...participant, inheritedFrom: { team: user.personalTeam, role: "member" }, directGrant: null }] }, projectId).items[0]?.directGrant).toBeNull();
  });
  it.each([
    member, { ...participant, profile: null }, { ...participant, profile: {} },
    { ...participant, profile: { ...participant.profile, email: false } },
    { ...participant, effectiveRole: "owner" }, { ...participant, directGrant: undefined },
    { ...participant, version: 1n }, { ...participant, directGrant: { ...grant, userId: otherId } },
    { ...participant, directGrant: { ...grant, projectId: otherId } },
  ])("rejects legacy, malformed, or source-mismatched participant rows %#", (value) => {
    expect(() => parseMembers({ actorAccess: directAccessFixture(projectId, userId), items: [value] }, projectId)).toThrow("invalid response");
  });
  it.each(["0", "-1", "1.5", "1e0", "9223372036854775808", '\"1\"', "null"])("rejects invalid nested grant version lexemes %s", async (version) => {
    const decoded = await decodeMembersJson(new Response(`{"actorAccess":${stringifyWireJson(directAccessFixture(projectId, userId))},"items":[${participantJson(version)}]}`));
    expect(() => parseMembers(decoded, projectId)).toThrow("invalid response");
  });
});

describe("project invitation parsing", () => {
  it("preserves nullable and populated invitation observations without inventing omitted values", () => {
    expect(parseInvitation(invitation, projectId)).toEqual(invitation);
    const consumed = { ...invitation, id: invitationId.toUpperCase(), projectId: projectId.toUpperCase(), createdBy: userId.toUpperCase(), consumedBy: otherId.toUpperCase(), consumedAt: time, revokedAt: time };
    expect(parseInvitation(consumed, projectId)).toEqual({ ...consumed, id: invitationId, projectId, createdBy: userId, consumedBy: otherId });
    expect(parseInvitations({ items: [invitation] }, projectId)).toEqual([invitation]);
    expect(parseInvitations({ items: [] }, projectId)).toEqual([]);
  });

  it.each([
    undefined, null, [], {},
    ...["id", "projectId", "createdBy", "createdAt", "expiresAt", "consumedBy", "consumedAt", "revokedAt"].map((field) => ({ ...invitation, [field]: undefined })),
    { ...invitation, consumedBy: "invalid" }, { ...invitation, consumedAt: false }, { ...invitation, revokedAt: "2026-02-30T00:00:00Z" },
  ])("rejects an incomplete or malformed invitation %#", (value) => {
    expect(() => parseInvitation(value)).toThrow("invalid response");
  });

  it("rejects another project's invitation and duplicate canonical identities in lists", () => {
    expect(() => parseInvitation({ ...invitation, projectId: otherId }, projectId)).toThrow("invalid response");
    expect(() => parseInvitations({ items: [{ ...invitation, projectId: otherId }] }, projectId)).toThrow("invalid response");
    expect(() => parseInvitations({ items: [invitation, { ...invitation, id: invitationId.toUpperCase() }] }, projectId)).toThrow("invalid response");
    expect(() => parseInvitations({ items: null }, projectId)).toThrow("invalid response");
  });

  it("accepts a same-origin invitation link with its opaque secret in the fragment", () => {
    const link = `${window.location.origin}/invitations#opaque-secret`;
    expect(parseCreatedInvitation({ ...invitation, link }, projectId)).toEqual({ ...invitation, link });
    expect(() => parseCreatedInvitation({ ...invitation, projectId: otherId, link }, projectId)).toThrow("invalid response");
  });

  it.each([
    undefined, null, "", "/invitations#secret", "not-a-url", "https://external.example/invitations#secret",
    ...["/invitations", "/invitations#", "/invitations/#secret", "/elsewhere#secret", "/invitations?token=secret#secret", "/invitations#secret\n", "/invitations#secret\u0000", "/invitations#secret value"].map((path) => `${window.location.origin}${path}`),
    `${window.location.protocol}//user:secret@${window.location.host}/invitations#secret`,
  ])("rejects an unsafe or incomplete created invitation link without leaking it %#", (link) => {
    expect(() => parseCreatedInvitation({ ...invitation, link }, projectId)).toThrowError(/^The server returned an invalid response\.$/);
  });

  it("parses direct and inherited access and binds the grant to the inspected identity", () => {
    const empty = { projectId, projectName: "Project", directGrant: null, access: null };
    const access = { ...directAccessFixture(projectId, userId), directGrant: grant };
    expect(parseInvitationInspection(empty, userId)).toEqual(empty);
    expect(parseInvitationInspection({ ...empty, directGrant: grant, access }, userId)).toEqual({ ...empty, directGrant: grant, access });
    expect(() => parseInvitationInspection({ ...empty, directGrant: { ...grant, userId: otherId }, access }, userId)).toThrow("invalid response");
    expect(() => parseInvitationInspection({ ...empty, directGrant: grant }, userId)).toThrow("invalid response");
  });

  it.each([undefined, null, [], {}, { projectId, projectName: "" }, { projectId, projectName: "Project" },
    { projectId, projectName: "Project", directGrant: null, access: undefined }, { projectId, projectName: "Project", directGrant: {}, access: null },
  ])("rejects malformed inspection metadata %#", (value) => {
    expect(() => parseInvitationInspection(value, userId)).toThrow("invalid response");
  });
});
