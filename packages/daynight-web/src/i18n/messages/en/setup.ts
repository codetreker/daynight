import type { SetupMessages } from "../setup";

export const setup: SetupMessages = {
  navigation: "Setup guide",
  eyebrow: "GET STARTED",
  title: "Set up your tools and start working",
  subtitle: "Connect the CLI and your Agent to keep project tasks and discussions in sync.",
  currentService: "Current service",
  stepsLabel: "Setup steps",
  successLabel: "Success",
  agentRequest: "Agent request",
  returnToProjects: "Back to projects",
  copyLabel: ({ title }) => `Copy: ${title}`,
  copyStatus: {
    pending: "Copying…",
    copied: "Copied.",
    failed: "Your browser could not copy this text. Select it and copy it manually.",
  },
  steps: {
    install: {
      title: "Install the Daynight CLI",
      description: "Use the latest patch of Node.js 22 or newer, then install the CLI in your terminal.",
      success: "The terminal displays the installed version.",
    },
    login: {
      title: "Sign in to your account",
      description: "Run the login command in your terminal. In your browser, compare the code and confirm the account before approving.",
      note: "For a remote terminal, use daynight login --no-browser. The default service is https://daynight.cc; no service address configuration is needed for everyday use.",
      success: "The terminal confirms that you are signed in.",
    },
    project: {
      title: "Create or find your repository project",
      description: "Run these commands in your Git repository with an origin remote. A single matching project is returned if it already exists, keeping its name.",
      command: 'daynight project create "Project name"\ndaynight task list',
      note: "Task commands discover the project from the current repository. If multiple projects match, use the project ID reported by the CLI to choose one explicitly.",
      success: "The CLI returns a project and reads its task list. An empty list is expected for a new project.",
    },
    skill: {
      title: "Install the Agent skill",
      description: "Install Codex, Copilot CLI or Claude Code first. In an interactive terminal, select your detected Agents, then User or Project scope. Project scope requires a Git worktree.",
      note: "Follow the Agent-specific reload instructions printed by the installer. Codex may need a new session; Copilot CLI uses /skills reload and /skills info using-daynight; Claude Code uses /reload-skills when a new top-level skill directory was created.",
      success: "Your Agent recognizes using-daynight.",
    },
    start: {
      title: "Start using Daynight",
      description: "Send the following request to your Agent, then open your project to see the new task.",
      example: "Use using-daynight to register a task for this project: improve the installation instructions.",
      success: "The new task appears in the Web app or daynight task list.",
    },
  },
};
