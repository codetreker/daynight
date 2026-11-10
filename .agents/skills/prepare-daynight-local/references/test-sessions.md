# Run Controller Test Sessions

`daynight controller codex|claude|copilot` starts a standalone Test Session. The
Controller supervises a private native session in the current directory,
registers it with the configured Daynight service, prints `Test Session: <url>`
and keeps running until it is interrupted. A Test Session is not a Worker claim
and cannot replace the managed [test loop](local-test-loop.md). The
[Test Session requirements](../../../../docs/spec/controller-test-sessions.md)
own its behavior; inspect the current CLI help for options and subcommands.

## Prepare each Provider and workspace

- Complete the applicable [verification layers](verification.md). Run the
  development entry with the explicit development root, as for every development
  command.
- Preflight each Provider in scope before relying on it. In the launch context,
  check only whether its required environment variables are present, start one
  Test Session and confirm a short reply. Record an account or credential
  failure, such as an expired sign-in, as an environment limitation rather than a
  product finding. Do not change the user's native accounts.
- Give each Provider its own disposable workspace, for example a worktree of the
  test checkout on a disposable branch in a sibling directory outside that
  checkout. Concurrent sessions cannot overwrite each other's files, and cleanup
  leaves the test checkout untouched. Do not use the Daynight source checkout or
  a Worker's prepared repository as a workspace.
- Native agents load the user's own configuration: global instructions, skills,
  plugins and instruction files in ancestor directories of the workspace. Account
  for them as described in
  [test repository preparation](test-repository.md#account-for-agent-instruction-files).
  Session content is therefore not synthetic data.

## Launch and keep the Controller running

Run each Controller as a long-lived process in an owned terminal multiplexer
session, started through the user's established interactive shell so that the
native Provider environment is inherited. Log only nonsecret lines: the printed
URL, readiness and stop results, and presence booleans for required variables.
For example, with `tmux` and zsh:

```bash
tmux new-session -d -s "dn-test-$DN_PROVIDER" \
  "zsh -l -i -c 'cd \"$DN_SESSION_WORKSPACE\" && DN_CONFIG_DIR=\"$DN_DEV_ROOT\" exec \"$DN_DEV_CLI\" controller $DN_PROVIDER'"
tmux pipe-pane -t "dn-test-$DN_PROVIDER" -o "cat >> \"$DN_SESSION_LOG\""
```

Record the Test Session ID, Provider, workspace, development snapshot and private
log location. Strip terminal control sequences before quoting log lines. Open the
printed URL in the isolated browser with the same test persona as the CLI. Judge
readiness by the final readiness line and the page state, not by single
intermediate log lines.

## Produce the states a scenario needs

| State | Method |
| --- | --- |
| Ordinary turn | A short prompt that needs no tools |
| Tool call | A harmless command inside the workspace, such as listing its files |
| Approval | Codex: set Approval policy to `Untrusted` under Permissions, then request a command. Claude Code: its default permission mode asks before writes and some commands. GitHub Copilot: set Tool approvals to ask. Name explicit relative paths inside the workspace |
| Long turn | Ask the agent to run a `sleep` of 30–90 seconds; use it to exercise Interrupt and, where the Provider supports it, Add to current turn |
| Settings | Change the model or permissions and confirm the applied value, not only the pending one |
| Archive | Stop the Controller with Ctrl+C; confirm the archive message, the read-only page, and that the list of online sessions no longer shows it |

Approve only requests that stay inside the workspace, and deny any request that
reaches personal files or other directories. Send only the prompts a scenario
needs.

## Stop and clean up

Stop each owned Controller with Ctrl+C in its own terminal and confirm the archive
result. Before signalling any process, identify it by its launch arguments and
parent: Controllers that a production Worker manages run from the stable package
under that Worker and are not yours to stop. After the archive is confirmed,
remove the owned disposable worktrees and their branches, and revert any local
Git exclude entries you added. Archived sessions are product data; keep them
unless their cleanup is explicitly in scope.
