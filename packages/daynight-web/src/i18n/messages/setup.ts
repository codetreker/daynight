type GuideStepMessages = {
  readonly title: string;
  readonly description: string;
  readonly success: string;
};

export type SetupMessages = {
  readonly navigation: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly subtitle: string;
  readonly currentService: string;
  readonly pathNavigation: string;
  readonly mcpTitle: string;
  readonly cliTitle: string;
  readonly cliDescription: string;
  readonly mcp: {
    readonly description: string;
    readonly stepsLabel: string;
    readonly client: string;
    readonly scope: string;
    readonly endpoint: string;
    readonly terminal: string;
    readonly configure: string;
    readonly configureDescription: string;
    readonly configureSuccess: string;
    readonly clientDocumentation: string;
    readonly authorize: string;
    readonly authorizeDescription: string;
    readonly authorizeNote: string;
    readonly authorizeSuccess: string;
    readonly copilotAuth: string;
    readonly otherAuth: string;
    readonly remote: string;
    readonly remoteNote: string;
    readonly session: string;
    readonly verify: string;
    readonly verifyDescription: string;
    readonly teamRequest: string;
    readonly verifySuccess: string;
    readonly manual: string;
    readonly tokens: string;
    readonly accountNote: string;
    readonly pat: string;
  };
  readonly stepsLabel: string;
  readonly successLabel: string;
  readonly agentRequest: string;
  readonly returnToProjects: string;
  readonly copyLabel: (args: { readonly title: string }) => string;
  readonly copyStatus: Readonly<Record<"pending" | "copied" | "failed", string>>;
  readonly steps: {
    readonly install: GuideStepMessages;
    readonly login: GuideStepMessages & { readonly note: string };
    readonly project: GuideStepMessages & { readonly command: string; readonly note: string };
    readonly skill: GuideStepMessages & { readonly note: string };
    readonly start: GuideStepMessages & { readonly example: string };
  };
};
