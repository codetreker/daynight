import { describe, expect, it } from "vitest";
import { parseInvitationLink } from "../../../src/commands/invitation/input.js";
import { formatError } from "../../../src/platform/diagnostics.js";

const origin = "https://daynight.example";
const token = `dninvite_${Buffer.alloc(32, 3).toString("base64url")}`;
const teamToken = `dnteam_${Buffer.alloc(32, 4).toString("base64url")}`;

describe("invitation link parsing", () => {
  it("dispatches canonical links for this service", () => {
    expect(parseInvitationLink(`${origin}/invitations#${token}`, origin)).toEqual({ scope: "project", token });
    expect(parseInvitationLink(`${origin}/team-invitations#${teamToken}`, origin)).toEqual({ scope: "team", token: teamToken });
  });
  it.each([
    `https://other.example/invitations#${token}`, `${origin}/team-invitations#${token}`,
    `${origin}/invitations?x=1#${token}`, `${origin}/invitations#${token}\nextra`,
    `${origin}/invitations/#${token}`, `${origin}/other/../invitations#${token}`,
    `${origin}/invitations#${token}x`, `https://user@daynight.example/invitations#${token}`,
  ])("rejects unsafe or noncanonical links without disclosing them", (link) => {
    try { parseInvitationLink(link, origin); throw new Error("accepted"); }
    catch (error) { expect(formatError(error)).toContain("Invalid invitation link"); expect(formatError(error)).not.toContain(token); }
  });
});
