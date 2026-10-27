import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultRepositoryRoot, repositoryLocation, repositoryPathComponent, resolveRepositoryRoot } from "../../src/repository/location.js";

const paths = { configFile: "/home/member/.daynight/config.yml" };

describe("repository locations", () => {
  it("shares the default root and resolves home and configuration-relative roots", () => {
    expect(defaultRepositoryRoot).toBe("~/daynights");
    expect(resolveRepositoryRoot(defaultRepositoryRoot, paths, "/home/member", path.posix)).toBe("/home/member/daynights");
    expect(resolveRepositoryRoot("~", paths, "/home/member", path.posix)).toBe("/home/member");
    expect(resolveRepositoryRoot("../clones", paths, "/home/member", path.posix)).toBe("/home/member/clones");
    expect(resolveRepositoryRoot("/clones", paths, "/home/member", path.posix)).toBe("/clones");
    expect(resolveRepositoryRoot("~\\clones", { configFile: "C:\\Users\\member\\.daynight\\config.yml" }, "C:\\Users\\member", path.win32)).toBe("C:\\Users\\member\\clones");
  });

  it.each([null, "", "~someone/clones", "root\0suffix"])("rejects invalid roots %j", (root) => {
    expect(() => resolveRepositoryRoot(root, paths, "/home/member", path.posix)).toThrow("repositoryRoot");
  });

  it("rejects relative homes and Windows drive-relative roots", () => {
    expect(() => resolveRepositoryRoot("~/clones", paths, "relative", path.posix)).toThrow("absolute path");
    expect(() => resolveRepositoryRoot("C:relative", { configFile: "C:\\config.yml" }, "C:\\Users\\member", path.win32)).toThrow("drive-relative");
  });

  it.each(["https://github.com/acme/repo.git", "git@github.com:acme/repo", "ssh://git@github.com:22/acme/repo.git"])("shares ordinary clone coordinates across equivalent transports: %s", (remote) => {
    expect(repositoryLocation(remote, "/clones", path.posix)).toBe("/clones/github.com/acme/repo");
  });

  it("preserves nested paths and case in general Git identities", () => {
    expect(repositoryLocation("https://git.example/Team/Nested/Repo.git", "/clones", path.posix)).toBe("/clones/git.example/Team/Nested/Repo");
    expect(repositoryLocation("git@git.example:Team/Nested/Repo.git", "C:\\clones", path.win32)).toBe("C:\\clones\\git.example\\Team\\Nested\\Repo");
  });

  it("separates users, ports, schemes and absolute SCP paths", () => {
    const remotes = [
      "git@git.example:team/repo", "builder@git.example:team/repo", "ssh://builder@git.example/team/repo",
      "ssh://builder@git.example:2222/team/repo", "https://git.example:8443/team/repo", "git@git.example:/team/repo",
    ];
    const locations = remotes.map((remote) => repositoryLocation(remote, "/clones", path.posix));
    expect(new Set(locations).size).toBe(remotes.length);
    expect(locations[3]).toBe("/clones/@remote/ssh/builder@git.example%3A2222/team/repo");
    expect(locations[5]).toBe("/clones/@remote/scp/git@git.example/%00/team/repo");
    for (const location of locations) expect(location.startsWith("/clones/")).toBe(true);
    expect(repositoryLocation("builder@git.example:team/repo]:tail", "/clones", path.posix)).toBe("/clones/@remote/scp/builder@git.example/team/repo]%3Atail");
  });

  it("keeps IPv6 addresses and encoded path segments distinct", () => {
    expect(repositoryLocation("ssh://builder@[::1]:2222/team/repo", "/clones", path.posix)).toBe("/clones/@remote/ssh/builder@[%3A%3A1]%3A2222/team/repo");
    expect(repositoryLocation("https://git.example/team/a%2Fb", "/clones", path.posix)).not.toBe(repositoryLocation("https://git.example/team/a/b", "/clones", path.posix));
  });

  it("encodes portable components without percent or traversal collisions", () => {
    const components = ["", ".", "..", "%2E", "CON", "con.txt", "repo.", "repo%2E", "host:8443", "a/b", "a\\b", "中文目录"];
    const encoded = components.map(repositoryPathComponent);
    expect(new Set(encoded).size).toBe(components.length);
    expect(repositoryPathComponent("CON")).toBe("%43ON");
    expect(repositoryPathComponent("repo.")).toBe("repo%2E");
    expect(repositoryPathComponent("repo%2E")).toBe("repo%252E");
    for (const value of encoded) { expect(value).not.toMatch(/[<>:"/\\|?*]/); expect(value).not.toMatch(/\.$/); }
  });
});
