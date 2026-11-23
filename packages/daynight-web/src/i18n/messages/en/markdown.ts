import type { MarkdownMessages } from "../markdown";

export const markdown: MarkdownMessages = {
  table: "Table",
  code: "Code",
  resourceUnavailable: "Resource unavailable",
  footnoteLabel: "Footnotes",
  footnoteBackLabel: "Back to reference",
  mermaid: {
    loading: "Rendering diagram…", diagram: "Diagram", source: "View Mermaid source",
    failed: "Unable to render this diagram. Check the Mermaid source below.",
    configuration: "Diagram configuration is not supported. Remove Mermaid directives or frontmatter and check the source below.",
    unsupported: "This Mermaid diagram type is not supported.",
    tooLarge: "Diagram source exceeds 50,000 characters. Reduce the source below.",
    complexity: "Diagram exceeds the complexity limit. Reduce the source below.",
    image: "Image nodes are not supported. Use text nodes in the Mermaid source below.",
  },
};
