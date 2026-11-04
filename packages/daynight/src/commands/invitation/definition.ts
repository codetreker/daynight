import type { CommandDefinition, CommandOption } from "../../cli/schema.js";

const help: CommandOption = { names: ["-h", "--help"], description: "Show this help", action: "help" };
const stdin: CommandOption = { names: ["--stdin"], description: "Read one invitation link from standard input (maximum 4096 bytes)" };
const json: CommandOption = { names: ["--json"], description: "Print the complete API result as JSON" };
const confirm: CommandOption = { names: ["--confirm"], description: "Confirm acceptance without an interactive prompt" };
export const invitationDefinition: CommandDefinition = {
  name: "invitation", description: "Inspect or accept an invitation for the current account",
  commands: [
    { name: "inspect", description: "Preview an invitation without consuming it", options: [stdin, json, help], details: "Enter the same-service invitation link using hidden terminal input, or provide it through --stdin. Never pass a link or token as an argument." },
    { name: "accept", description: "Accept an invitation as the current account", options: [stdin, confirm, json, help], details: "Enter the same-service invitation link using hidden terminal input, or provide it through --stdin. Noninteractive acceptance requires --confirm. Never pass a link or token as an argument." },
  ], options: [help], details: "Run daynight invitation <command> --help for command usage.",
};
