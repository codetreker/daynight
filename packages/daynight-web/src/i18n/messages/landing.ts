import type { DemoDocumentId, DemoReceiptId, DemoSceneId, DemoTaskId, DemoTaskState } from "../../features/landing/demo";

type TextPair = { readonly title: string; readonly body: string };
type DemoDocument = {
  readonly label: string;
  readonly meta: string;
  readonly title: string;
  readonly sections: readonly { readonly title: string; readonly body?: string; readonly items?: readonly string[] }[];
  readonly callout: TextPair;
};
type DemoReceipt = {
  readonly title: string;
  readonly records: readonly TextPair[];
  readonly note: string;
};

export type LandingMessages = {
  readonly metadata: { readonly title: string; readonly description: string };
  readonly navigation: {
    readonly home: string; readonly main: string; readonly label: string; readonly why: string; readonly demo: string;
    readonly login: string; readonly workspace: string; readonly unknown: string; readonly identityFailed: string;
  };
  readonly hero: {
    readonly tag: string; readonly title: readonly [string, string]; readonly body: string; readonly demo: string;
    readonly start: string; readonly note: string; readonly agents: string; readonly previewLabel: string;
    readonly window: string; readonly confirmed: string; readonly shared: string; readonly project: string; readonly floating: string;
  };
  readonly why: { readonly eyebrow: string; readonly title: readonly [string, string]; readonly body: string; readonly items: readonly TextPair[] };
  readonly demo: {
    readonly eyebrow: string; readonly title: readonly [string, string]; readonly intro: string; readonly project: string;
    readonly example: string; readonly breadcrumb: string; readonly sceneLabel: string;
    readonly scenes: Readonly<Record<DemoSceneId, { readonly label: string; readonly summary: string; readonly heading: string; readonly instruction: string }>>;
    readonly files: string; readonly fileAside: string; readonly documents: Readonly<Record<DemoDocumentId, DemoDocument>>;
    readonly tasksLabel: string; readonly task: (args: { readonly number: string }) => string;
    readonly states: Readonly<Record<DemoTaskState, string>>;
    readonly tasks: Readonly<Record<DemoTaskId, { readonly title: string; readonly description: string; readonly acceptance: readonly string[]; readonly result?: string }>>;
    readonly prerequisites: string; readonly noPrerequisites: string; readonly startingPoint: string; readonly completion: string;
    readonly readyNote: string; readonly runningNote: string; readonly blockedNote: (args: { readonly tasks: string }) => string;
    readonly completed: { readonly eyebrow: string; readonly title: readonly [string, string]; readonly body: string; readonly status: string; readonly note: string };
    readonly receiptsLabel: string; readonly receiptLabels: Readonly<Record<DemoReceiptId, string>>; readonly receipts: Readonly<Record<DemoReceiptId, DemoReceipt>>;
    readonly conclusion: string; readonly note: string;
  };
  readonly people: {
    readonly title: readonly [string, string]; readonly body: string;
    readonly audiences: readonly { readonly tag: string; readonly title: readonly [string, string]; readonly body: string; readonly note: string }[];
    readonly principle: string;
  };
  readonly start: { readonly eyebrow: string; readonly title: readonly [string, string]; readonly body: string; readonly guide: string; readonly steps: readonly TextPair[] };
  readonly faq: { readonly eyebrow: string; readonly title: readonly [string, string]; readonly items: readonly TextPair[] };
  readonly closing: { readonly title: readonly [string, string]; readonly body: string; readonly demo: string; readonly start: string };
  readonly footer: { readonly body: string; readonly guide: string };
};
