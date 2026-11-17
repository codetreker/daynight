export type MarkdownMessages = {
  readonly table: string;
  readonly code: string;
  readonly resourceUnavailable: string;
  readonly footnoteLabel: string;
  readonly footnoteBackLabel: string;
  readonly mermaid: {
    readonly loading: string;
    readonly diagram: string;
    readonly source: string;
    readonly failed: string;
    readonly configuration: string;
    readonly unsupported: string;
    readonly tooLarge: string;
    readonly complexity: string;
    readonly image: string;
  };
};
