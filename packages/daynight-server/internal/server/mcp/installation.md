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

Check `claude mcp login --help` for the installed version's browser options.
Use automatic callback-port selection unless a configured registration requires
a fixed port; do not change a callback URL during code exchange.

## GitHub Copilot CLI

```sh
copilot mcp add --transport http daynight {{MCP_SHELL_URL}}
```

In the Copilot interactive session, inspect the configuration and authenticate:

```text
/mcp get daynight
/mcp auth daynight
```

These are interactive commands, not shell commands. This syntax is verified
against Copilot CLI 1.0.112; consult the installed client's help for other
versions. Copilot's own GitHub login is separate from Daynight MCP authorization.

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

The client discovers OAuth authorization. Ask the account holder
to sign in through the browser and approve the `daynight:mcp` permission. This
step requires their participation. For a terminal without a local browser, use
`codex mcp login daynight --no-browser`, or the installed Claude version's
documented `claude mcp login daynight --no-browser`. Follow that client's
instructions for opening the link and returning the callback; do not assume
Copilot shares these shell commands or options.

Reload or restart the active agent after adding the server. Check that the
Daynight connection is authenticated, list its tools, and make a read-only call
such as `team_list`. The connection uses the account's existing permissions.

If the client supports HTTP headers but not OAuth, configure an existing
Daynight personal access token as `Authorization: Bearer <PAT>`. Keep the token
in the client's secret or environment settings. Each MCP client needs its own
connection configuration; running `daynight login` does not configure it.

Opening this URL normally returns this manual, not proof of OAuth or an MCP
connection. An unauthenticated protocol request returns discovery information;
authorization, token exchange, protocol connection and a successful read-only
tool call are separate checks. Let the client use its negotiated MCP version:
`2025-11-25` uses initialize, while `2026-07-28` does not require that removed
handshake. MCP protocol requests require
Bearer authentication; this stateless server does not offer a standalone SSE
stream. Use Streamable HTTP, not the legacy SSE transport.

For Copilot diagnostics, start a separate session with
`copilot --log-level debug --log-dir <isolated-directory>`. Logs may contain
credentials and complete authorization URLs: do not upload raw logs. Record
only the client version, failing stage, HTTP status and OAuth error, including
`X-OAuth-Error` when present. Never share tokens, codes, PKCE verifier, cookies,
state or complete authentication URLs. A PAT is an explicit alternative, not
evidence that OAuth succeeded.

Client documentation: [Codex](https://developers.openai.com/codex/mcp/),
[Claude Code](https://code.claude.com/docs/en/mcp),
[Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers).
