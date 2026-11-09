# Connect to Daynight MCP

This is a remote Streamable HTTP MCP server. Its endpoint is:

```text
{{MCP_URL}}
```

Configure your MCP client with this URL. A local Daynight server or the Daynight
CLI is not required. Use the instructions for the client that runs your agent.

## Codex

```sh
codex mcp add daynight --url {{MCP_SHELL_URL}}
codex mcp login daynight
codex mcp list
```

## Claude Code

```sh
claude mcp add --transport http daynight {{MCP_SHELL_URL}}
claude mcp login daynight
claude mcp get daynight
```

## Other MCP clients

Choose a remote HTTP / Streamable HTTP server and enter the endpoint above.
For clients whose configuration uses `mcpServers` with a `type` field, merge
this entry into the existing configuration:

```json
{
  "mcpServers": {
    "daynight": {
      "type": "http",
      "url": {{MCP_JSON_URL}}
    }
  }
}
```

Configuration formats differ between clients; use the client's HTTP server
settings if it does not accept this format.

## Authorize and verify

The client discovers OAuth authorization automatically. Ask the account holder
to sign in through the browser and approve the `daynight:mcp` permission. This
step requires their participation. For a terminal without a local browser,
Codex and Claude Code support `mcp login daynight --no-browser`; give the account
holder the displayed authorization URL.

Reload or restart the active agent after adding the server. Check that the
Daynight connection is authenticated, list its tools, and make a read-only call
such as `team_list`. The connection uses the account's existing permissions.

If the client supports HTTP headers but not OAuth, configure an existing
Daynight personal access token as `Authorization: Bearer <PAT>`. Keep the token
in the client's secret or environment settings. Each MCP client needs its own
connection configuration; running `daynight login` does not configure it.

Opening this URL normally returns this manual. MCP protocol requests require
Bearer authentication; this stateless server does not offer a standalone SSE
stream. Use Streamable HTTP, not the legacy SSE transport.

Client documentation: [Codex](https://developers.openai.com/codex/mcp/),
[Claude Code](https://code.claude.com/docs/en/mcp).
