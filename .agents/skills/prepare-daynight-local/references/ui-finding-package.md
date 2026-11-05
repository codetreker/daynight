# One Finding Package

Prepare one directory for each independently actionable improvement before the
[production handoff](ui-handoff.md). `task.md` owns the Chinese requirements,
observed behavior, bounded solution and acceptance criteria. The JSON manifest
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
  "format": "daynight-ui-finding-v1",
  "title": "窄屏项目标题被操作区挤压，影响识别项目",
  "description": "task.md",
  "prototype": "prototype.html",
  "evidence": ["evidence/before/evidence.json", "evidence/interaction.md"],
  "supportingFiles": []
}
```

Run with Node.js 24 from the selected development worktree:

```bash
node .agents/skills/prepare-daynight-local/scripts/validate-ui-finding.mjs \
  .tmp/ui-audit/one-finding/finding.json
```

The helper reads local files and prints their byte counts and SHA256 hashes. It
makes no network calls, changes no package files and has no Daynight command.
It rejects missing or empty files, duplicate file roles, paths escaping the
package, symbolic links inside the package and unknown manifest fields. Use
relative forward-slash paths without `.` or `..` components. The package root
itself must be a real directory. Keep the package at rest while checking it;
this is a trusted local-material check, not a filesystem security sandbox or an
atomic publication protocol.

For [capture-helper evidence](browser-evidence.md), the validator requires
`status: consistent` and includes the declared image or PDF automatically.
Geometry-only captures have no image. Keep failed or inconsistent attempts in
the private audit record, outside the handoff's evidence list, until coherent
evidence supports the finding. An interaction record may be Markdown or JSON;
it must name its actual method, source, route, viewport, state, actions and
observed results. The helper checks manual evidence bytes, not its truth.

Use inline Markdown links/images, angle brackets around paths with spaces or
parentheses, or single-line reference definitions in `task.md`. Quoted titles and
nested text labels are supported; code-span and fenced-code examples are ignored.
Local attachment links must target inventory files from the package root because
the content becomes an inline task description. Its source file's directory is
irrelevant: if `description` is `docs/task.md` and the prototype is uploaded as
`docs/prototype.html`, link to `docs/prototype.html`, not `prototype.html`.
Preserve package-relative paths when uploading. This follows the Web
[inline-description resolver](../../../../packages/daynight-web/src/features/task-detail/TaskDetailReading.tsx)
and [attachment path rules](../../../../packages/daynight-web/src/features/task-detail/attachments/model.ts).
URL path segments are decoded separately; encoded slashes/backslashes, control
characters and malformed encodings are rejected. Spaces, Unicode and literal
percent signs can be encoded within an individual segment.
HTTP(S) links and same-file anchors are allowed. This is a constrained package
format, not a full Markdown parser. Nested images in link labels are rejected: use an independent image and
link instead. Avoid HTML links, multiline reference definitions and executable
embeds in task material. Prefer a self-contained prototype; inspect any external
asset dependencies separately. Markdown attachments have their own document-relative
links; this helper validates the file used for the inline description.

An exit code of zero establishes file completeness and a byte inventory. It does
not establish that the issue is worth fixing, that the package contains only one
semantic issue, that the prototype works, or that the files are appropriate to
publish. Review those properties before upload. Revalidate after edits, then
compare downloaded attachment bytes with this inventory. A hash made before a
later edit cannot certify the new upload.

## Task description template

Adapt the detail to the finding; preserve unknowns instead of filling them with
guesses. This example is task material, so its prose is Chinese.

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

## 预期行为与方案

窄屏仍能识别标题并触达所有操作。说明建议的排列、换行、截断或展开行为；
需要视觉取舍时使用[交互原型](prototype.html)。
区分已核实的原因与待实现者确认的定位线索，链接相关固定源码及适用设计原则。
说明为何此处值得调整，不以单个尺寸或个人偏好代替影响判断。

## 验收

- 原复现场景：标题可读，操作可达，无遮挡或意外溢出。
- 邻近宽度与内容：短标题、长中英文标题、相关断点两侧。
- 输入方式：适用的鼠标、键盘、触控；明确未实际覆盖的设备。
- 相关状态：加载、展开/关闭、切换、返回后仍满足上述行为。
- 修复后在实际产品页面重测；原型和组件测试不替代该结果。
```

For a keyboard defect, lead with the intended focus/action sequence and before/
after focus targets. For a responsive defect, include both the failing width and
a useful neighboring layout. A task does not need an unrelated matrix or a new
design system to fix one observable problem.

Open and operate the prototype before handoff: test its controls, keyboard path
and intended width. If an attachment preview uses an iframe, verify that its
sandbox permits the prototype's necessary behavior. A blocked prototype form is
not evidence of the product's behavior. Keep process bookkeeping, assignment
attempts and authorization history in the private audit record, not `task.md`.
