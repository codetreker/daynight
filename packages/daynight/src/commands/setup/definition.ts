import type { CommandDefinition } from "../../cli/schema.js";

export const setupDefinition: CommandDefinition = {
  name: "setup",
  description: "Configure review repositories and optional test server access",
  options: [
    { names: ["--server-url"], description: "HTTP(S) server origin", value: { name: "url", kind: "text" } },
    { names: ["--server-token-stdin"], description: "Read one personal access token from piped stdin" },
    { names: ["--review-repo"], description: "HTTPS or SSH GitHub repository address", value: { name: "remote", kind: "text" } },
    { names: ["--review-path"], description: "Dedicated review clone path (requires --review-repo)", value: { name: "path", kind: "directory" } },
    { names: ["-h", "--help"], description: "Show this help", action: "help" },
  ],
  details: "Without options, configure a review repository interactively.\nThe default service is https://daynight.cc; run daynight login to authenticate.\nExplicit --server-url overrides the origin for testing.\n--server-token-stdin reads one optional automation token for the effective service origin.\nChanging the server origin clears its token unless a replacement is supplied.\nReview clone paths default to repositoryRoot (default: ~/daynights).",
};
