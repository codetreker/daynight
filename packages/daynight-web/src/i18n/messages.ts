import type { WorkersMessages } from "./messages/workers";
import type { TaskStatus } from "../api/types";
import type { WorkspaceMessages } from "./messages/workspace";
import type { GraphMessages } from "./messages/graph";
import type { PlatformMessages } from "./messages/platform";
import type { AutomationMessages } from "./messages/automation";
import type { InspectionMessages } from "./messages/inspection";
import type { ExecutionMessages } from "./messages/execution";
import type { AuthMessages } from "./messages/auth";
import type { SetupMessages } from "./messages/setup";
import type { LandingMessages } from "./messages/landing";
import type { Locale, LocaleIssue } from "./locale";
import { en } from "./messages/en";
import { zhCN } from "./messages/zh-CN";

export type Messages = {
  readonly common: {
    readonly retrySave: string;
    readonly status: Readonly<Record<TaskStatus, string>>;
    readonly requestId: string;
  };
  readonly workspace: WorkspaceMessages;
  readonly workers: WorkersMessages;
  readonly graph: GraphMessages;
  readonly inspection: InspectionMessages;
  readonly automation: AutomationMessages;
  readonly platform: PlatformMessages;
  readonly auth: AuthMessages;
  readonly setup: SetupMessages;
  readonly landing: LandingMessages;
  readonly execution: ExecutionMessages;
  readonly language: {
    readonly label: string;
    readonly options: Readonly<Record<Locale, string>>;
    readonly preferenceNotice: Readonly<Record<LocaleIssue["kind"], string>>;
  };
};

export const messagesByLocale: Readonly<Record<Locale, Messages>> = {
  en,
  "zh-CN": zhCN,
};
