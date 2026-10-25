import type { CommandDefinition } from "../../cli/schema.js";

export const loginDefinition: CommandDefinition = {
  name: "login",
  description: "Sign in through a browser using a device code",
  options: [
    { names: ["--no-browser"], description: "Display the authorization link without opening a browser" },
    { names: ["-h", "--help"], description: "Show this help", action: "help" },
  ],
  details: "Sign in to https://daynight.cc, or the optional configured test server.\nOpen the displayed link on any device and confirm the code and account.\nCredentials are saved only after authorization; existing credentials remain on failure.",
};

export const logoutDefinition: CommandDefinition = {
  name: "logout",
  description: "Revoke the current CLI credential and remove it locally",
  options: [{ names: ["-h", "--help"], description: "Show this help", action: "help" }],
  details: "Revokes the credential for the effective service origin before removing it locally.\nA connection failure preserves the local credential so the result can be checked.",
};
