export type McpClient = "codex" | "claude" | "copilot";

// A shell single-quoted argument represents an embedded quote by closing and
// reopening the quoted string around an escaped quote.
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export const mcpConfiguration = (client: McpClient, endpoint: string) => {
  const quotedEndpoint = shellQuote(endpoint);
  switch (client) {
    case "codex":
      return {
        command: `codex mcp add daynight --url ${quotedEndpoint}\ncodex mcp login daynight`,
        remoteCommand: "codex mcp login daynight --no-browser",
        documentation: "https://developers.openai.com/codex/mcp/",
      };
    case "claude":
      return {
        command: `claude mcp add --transport http --scope user daynight ${quotedEndpoint}\nclaude mcp login daynight`,
        remoteCommand: "claude mcp login daynight --no-browser",
        documentation: "https://code.claude.com/docs/en/mcp",
      };
    case "copilot":
      return {
        command: `copilot mcp add --transport http daynight ${quotedEndpoint}`,
        remoteCommand: null,
        documentation: "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers",
      };
  }
};
