# One Finding Package

Prepare one directory for each independently actionable improvement before
[the production handoff](handoff.md). `task.md` owns the Chinese requirements,
observed behavior, selected solution, detailed design, ordered implementation
steps and acceptance criteria. The JSON manifest
lists its files; it does not duplicate the task definition.

## Files and local validation

An example directory is:

```text
one-finding/
  finding.json
  task.md
  prototype.html
  evidence/
    before/
      evidence.json
      screen.png
    interaction.md
```

`finding.json`:

```json
{
  "format": "daynight-finding-v1",
  "title": "窄屏项目标题被操作区挤压，影响识别项目",
  "description": "task.md",
  "prototype": "prototype.html",
  "evidence": ["evidence/before/evidence.json", "evidence/interaction.md"],
  "supportingFiles": []
}
```

`prototype` is optional in `daynight-finding-v1`; the topic skill decides when a
finding needs one. A finding that changes no visual interface, such as a CLI
message or a Provider's data projection, describes the expected text or output in
`task.md` instead. Packages in the earlier `daynight-ui-finding-v1` format remain
valid and still require `prototype`.

Run with Node.js 24 from the Daynight checkout:

```bash
node .agents/skills/discover-daynight-improvements/scripts/validate-finding.mjs \
  --forbid "$HOME" --forbid "$(id -un)" \
  .tmp/investigation/one-finding/finding.json
```

The helper reads local files and prints their byte counts and SHA256 hashes. It
makes no network calls, changes no package files and has no Daynight command.
It rejects missing or empty files, duplicate file roles, paths escaping the
package, symbolic links inside the package and unknown manifest fields. Use
relative forward-slash paths without `.` or `..` components. The package root
itself must be a real directory. Keep the package at rest while checking it;
this is a trusted local-material check, not a filesystem security sandbox or an
atomic publication protocol.

Each `--forbid` value is matched case-insensitively against every text file in
the inventory, including capture records. A match fails validation and names the
file and the value. Binary files such as screenshots and PDFs are listed under
`privacyScan.unscanned`; review them visually before upload. Choose the values
under [the private-data screening](evidence.md#screen-private-data-before-upload).

For [capture-helper evidence](../../prepare-daynight-local/references/browser-evidence.md),
the validator requires `status: consistent` and includes the declared image or
PDF automatically. Geometry-only captures have no image. Keep failed or
inconsistent attempts in the private record, outside the evidence list, until
coherent evidence supports the finding. An interaction record may be Markdown or
JSON; it must name its actual method, source, route, conditions, state, actions,
sampling when it is a time series, and observed results. The helper checks the
bytes of manual evidence, not its truth.

Use inline Markdown links and images, angle brackets around paths with spaces or
parentheses, or single-line reference definitions in `task.md`. Quoted titles and
nested text labels are supported; code-span and fenced-code examples are ignored.
Local attachment links must target inventory files from the package root because
the content becomes an inline task description. Its source file's directory is
irrelevant: if `description` is `docs/task.md` and the prototype is uploaded as
`docs/prototype.html`, link to `docs/prototype.html`, not `prototype.html`.
Preserve package-relative paths when uploading. This follows the Web
[inline-description resolver](../../../../packages/daynight-web/src/features/task-detail/TaskDetailReading.tsx)
and [attachment path rules](../../../../packages/daynight-web/src/features/task-detail/attachments/model.ts).
URL path segments are decoded separately; encoded slashes or backslashes, control
characters and malformed encodings are rejected. Spaces, Unicode and literal
percent signs can be encoded within an individual segment. HTTP(S) links and
same-file anchors are allowed. This is a constrained package format, not a full
Markdown parser. Nested images in link labels are rejected: use an independent
image and link instead. Avoid HTML links, multiline reference definitions and
executable embeds in task material. Markdown attachments have their own
document-relative links; this helper validates the file used for the inline
description.

An exit code of zero establishes file completeness, a byte inventory and the
absence of the supplied strings in text files. It does not establish that the
issue is worth fixing, that the package contains only one semantic issue, that a
prototype works, or that images and other files are appropriate to publish.
Review those properties before upload. Revalidate after edits, then compare
downloaded attachment bytes with this inventory. A hash made before a later edit
cannot certify the new upload.

## Task description template

Adapt the detail to the finding under the [task content standard](../../../../packages/daynight/src/commands/skill/skills/using-daynight/references/task-content.md).
Resolve the investigation and design questions needed to select and implement the
solution before delivery handoff. Preserve verification limitations accurately.
This example is task material, so its prose is Chinese.

```markdown
# 窄屏项目标题被操作区挤压，影响识别项目

## 用户目标与问题

用户需要先识别当前项目，再选择任务。窄屏时标题被操作区挤成极窄的一列，
虽无页面横向溢出，仍难以阅读。此任务只处理项目标题与相邻操作区的布局。

## 复现条件与证据

- 源码：完整 commit；说明本地是否有影响结果的修改。
- 环境：localhost origin、route、locale、浏览器、viewport、缩放比例。
- 数据与状态：测试项目标题、权限、加载完成的可见标志、面板展开状态。
- 步骤：从稳定入口到问题出现的最少实际操作。
- 实际结果：可见内容、关键几何、操作结果及对用户的影响。
- [同状态采集](evidence/before/evidence.json)、[交互记录](evidence/interaction.md)。
- 说明未验证的真机、软键盘、动画或辅助技术行为。

## 原因与实现位置

列出已核实的原因和负责的源码位置（固定 commit 的永久链接）。移交前解决影响方案选择
或实现设计的定位问题，不把调查留给实现者。

## 预期行为与方案

窄屏仍能识别标题并触达所有操作。写清已选定的分组、各宽度区间的排列、换行与截断规则
及理由；[交互原型](prototype.html) 展现确定的视觉与交互。非界面问题给出期望的文字或
输出示例。详细设计明确负责标题与操作区布局的组件、尺寸和状态规则及必要交互，使接手者
可直接按材料落实。说明为何值得调整，不以单个尺寸或个人偏好代替影响判断。

## 实施步骤

按依赖顺序说明具体变更目标及每步预期结果，包括组件布局和状态规则的修改、必要交互
衔接，以及原复现场景和相关状态的产品页面验证。

## 约束与非目标

列出必须保持的权限、门禁、原生操作语义、草稿与焦点行为，以及不在本任务范围的相邻问题。

## 验收

- 原复现场景：标题可读，操作可达，无遮挡或意外溢出。
- 邻近宽度与内容：短标题、长中英文标题、相关断点两侧。
- 输入方式：适用的鼠标、键盘、触控；明确未实际覆盖的设备。
- 相关状态：加载、展开/关闭、切换、返回后仍满足上述行为。
- 修复后在实际产品页面重测；原型和组件测试不替代该结果。
```

For a keyboard defect, lead with the intended focus and action sequence and the
focus targets before and after. For a responsive defect, include the failing width
and a useful neighboring layout. For a performance finding, state the scenario,
measurement method and target. A task does not need an unrelated matrix or a new
design system to fix one observable problem.

When a prototype is attached, follow the topic skill's prototype standard, for
example [UI prototypes](../../audit-daynight-ui/references/prototypes.md). Keep
process bookkeeping, assignment attempts and authorization history in the
private record, not in `task.md`.
