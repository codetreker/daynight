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
