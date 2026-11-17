import type { MarkdownMessages } from "../markdown";

export const markdown: MarkdownMessages = {
  table: "表格",
  code: "代码",
  resourceUnavailable: "资源不可用",
  footnoteLabel: "脚注",
  footnoteBackLabel: "返回引用",
  mermaid: {
    loading: "正在渲染图表…", diagram: "图表", source: "查看 Mermaid 源码",
    failed: "无法渲染此图表，请检查下方 Mermaid 源码。",
    configuration: "不支持图块内配置，请移除 Mermaid 指令或 frontmatter，并检查下方源码。",
    unsupported: "不支持此 Mermaid 图表类型。",
    tooLarge: "图表源码超过 50,000 个字符，请缩减下方源码。",
    complexity: "图表超过复杂度限制，请缩减下方源码。",
    image: "不支持图片节点，请在下方 Mermaid 源码中使用文字节点。",
  },
};
