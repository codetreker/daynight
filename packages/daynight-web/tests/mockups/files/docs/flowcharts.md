# 流程图阅读示例

流程图使用相同的 Markdown 阅读样式。可以查看源码、切换附件、在独立页面重新打开，并在窄屏中滚动阅读较宽的图形。

## 条件分支与中文

```mermaid
flowchart TD
    A[开始] --> B{是否通过？}
    B -->|是| C[完成]
    B -->|否| D[修改]
    D --> B
```

## 横向流程与长标签

```mermaid
flowchart LR
    A[提交包含中文与 English 的完整方案和详细验收条件] --> B[核对任务描述和附件中的流程图]
    B --> C[在窄屏中水平滚动阅读全部节点与箭头]
    C --> D[验证通过后完成交付]
```

## 语法错误

错误局限在当前图块，源码保持可检查，其他正文和图形继续可读。

```mermaid
flowchart TD
    A[未闭合节点 --> B
```

## 配置保护

图块采用阅读器的安全配置。嵌入配置会显示局部错误及源码。

```mermaid
%%{init: {"securityLevel": "loose"}}%%
flowchart TD
    A[配置覆盖] --> B[保留源码]
```

## 原有 Markdown

| 内容 | 结果 |
| --- | --- |
| 普通代码块 | 保留代码语义 |
| 相对图片 | 按附件目录解析 |

```ts
const task = { status: 'in_progress' };
```

![项目流程](../images/workflow.svg)

[附件使用说明](guide.md) · [交互原型](../site/index.html)
