# Setup

Use this when first connecting to Daynight or confirming the current repository is ready to use. See the [CLI handbook](handbook.md) for finding commands and arguments.

1. Run `daynight --version` and `daynight --help` to confirm the CLI is available.
   If it is not installed, obtain user authorization and follow the [installation guide](https://daynight.cc/setup).
2. Confirm the target service and signed-in identity. When authentication is needed, use `daynight login` and have the user follow the prompts to verify the code and account in the browser and authorize access.
   See `daynight login --help` for remote-terminal options. Do not ask the user to provide credentials in chat.
3. Confirm the project for the current Git repository under [project management](project-management.md). If there is no project, obtain registration authorization before creating one; service or permission failures do not mean the project is absent.
4. Read the repository's `AGENTS.md` and `CLAUDE.md` to establish task tracking, language, workspace, delivery, and authorization rules.
   If repository instructions need to be added or adjusted, confirm the content and editing permission first; setup does not imply permission to rewrite instructions.
5. Confirm that project and task queries are accessible. Report actual failures and preserve completed configuration; do not bypass problems by creating duplicate projects.

Configure interactive completion with `daynight completion setup`.
Setting up and running a worker environment are separate operations; consult `daynight worker --help` first.
Ordinary task management does not require starting a worker.
