# Use the Local Website with the CLI

Use this guide for the browser leg of the [localhost test loop](local-test-loop.md).
Follow [environment verification](verification.md) for origin and repository
checks. Public browsing can precede repository selection; fixture creation and
dispatch require the selected repository and an isolated test pool.

## Open the correct site and account

Open the exact public origin recorded for the local environment. Keep the CLI
and browser on that same origin, including hostname and port; a Vite backend can
have a different health-check origin. Confirm the signed-in account through
Account settings (`账户设置`) and compare it with the local CLI account.
Use full IDs returned by this service, not production bookmarks or copied IDs.

For ordinary localhost acceptance, first follow
[local identity and headless browser setup](local-identity.md). The canonical
test helper establishes a genuine local browser session in an isolated context;
the CLI uses that same persona's PAT. It does not require a user's GitHub login,
existing browser profile or device approval. Keep authentication preparation
separate from the UI observations below.

Verify the source revision of the running UI and server; an old artifact may lack
Steps, Discussion or Worker Configuration. Use accessible names in the current
locale; a missing control requires a version/access check, not an API workaround.

Public routes can render without a working authenticated backend. On `/`, demo
tabs show built-in examples, not live projects, and the language selector retains
its selection. `/setup` is a public guide; its copy buttons confirm copying,
not command execution or configuration.

The setup page may display localhost while its `npm install` and `daynight login`
examples still describe the default `daynight.cc` connection. Do not execute
these copies as localhost setup; first use this skill's development build,
mapped `daynight` and explicit development root. If `/projects` reports that
login status cannot be confirmed (`暂时无法确认登录状态`), use Retry after restoring
the backend and leave authenticated navigation unverified.

Use Edge by default, or the user's selected browser, in headless mode. Launch
Edge with an independent Playwright context; do not switch to Chrome for
automation convenience or connect to an ordinary signed-in profile. This keeps
checks out of the user's foreground window. If the user specifically requests
manual exploration or real OAuth, follow
[the optional real-login procedure](local-identity.md#optional-real-oauth-and-device-authorization)
instead. Browser or credential failure leaves that layer unverified; an API-only
check does not complete it.

## Page readiness and background requests

Wait for the expected authenticated route, `/api/v1/me` result and actual controls
before acting. Inspect the rendered DOM and accessible names, then use those
controls; a fixed delay or HTTP 200 for the page is insufficient. Capture only
credential-free network metadata and relevant UI state.

The authenticated shell pauses protected requests when the document becomes
hidden or loses top-level focus. It resumes them after the page is visible and
focused and the foreground `/api/v1/me` identity check succeeds. A normal hidden
browser tab and an isolated headless page are different contexts. In the owned
headless page, read `document.visibilityState` and `document.hasFocus()` and
observe the actual requests. Do not override these properties, synthesize focus
events, or intercept product responses to bypass the gate. If the browser cannot
supply a usable page, report the missing UI leg and its observed state.

A confirmation dialog closing or a temporarily disabled switch does not prove
that its mutation reached the server. Preserve the page while the action is
pending, avoid resubmission, and read the same task with the CLI. A resumed
request can be rejected before sending when the reviewed task version or access
scope has changed; after pending ends, reconcile the current task before deciding
whether a new confirmation is needed. A transient conflict notice may already
have disappeared by then.

For a user-requested ordinary browser tab, preserve their foreground tab and
accounts. A background device page can remain at Loading sign-in request…
(`正在读取登录请求…`) before its inspection fetch starts. Do not repeatedly prompt
the user to focus it or treat successful CLI polling as browser success. Record
the paused leg and continue independent checks; manual activation belongs to the
user. Source behavior is a diagnostic possibility, not proof of the cause of
every loading screen.

### Distinguish browser-platform failures from product failures

If a screenshot or an action waiting for animation-frame stability times out,
test a bounded `requestAnimationFrame` and screenshot on a separate blank page
in the same owned browser. A failure there as well is evidence of a browser or
automation-platform problem; it is not a Daynight rendering defect. Record the
browser version, operation, timeout and blank-page result. Do not repeatedly
retry the same failed operation or change product focus/visibility behavior to
make the harness pass.

Other browser operations can still work. Inspect the actual target's visibility,
bounding rectangle and hit target, then try an ordinary `page.mouse.click` at its
center when pointer interaction is required. Verify the real UI result and the
expected server readback. This remains a pointer test; DOM `.click()`, forced
actions or direct API writes do not prove that users can reach the control.
Keyboard navigation supplies separate evidence. Do not describe an untested
input method as covered by another method's success.

When capture alone is unavailable, a screen-media PDF can preserve static visual
evidence: use `page.emulateMedia({ media: 'screen' })`, then `page.pdf` with explicit
viewport-equivalent dimensions and background printing. Retain the PDF with DOM
geometry and label how it was generated. It is not a compositor screenshot and
does not verify animation, frame stability, browser chrome or a real phone's
soft keyboard. Desktop viewport emulation also cannot establish mobile
`visualViewport` behavior during keyboard opening. Keep those checks unverified
until a suitable browser or device is available. Topic skills such as
`audit-daynight-ui` define coverage and finding evidence for investigations.

## Find the project and fixture

1. Open My Projects (`我的项目`) at `/projects`. Select the intended personal or
   team context when the sidebar provides that choice.
2. Open the project whose repository and full ID match the CLI readback. Its
   address is `/projects/<projectId>`.
3. Open Task list (`任务列表`), then Task chains (`任务链`) or Standalone tasks
   (`独立任务`). An acceptance task without ordinary dependencies is independent.
4. If the task is absent, check the assignee filter and the Status (`状态`)
   filter; All statuses (`全部状态`) includes completed tasks. A filtered list
   does not prove deletion.
5. Open the task and check its unique run marker, description, assignee and
   status. A direct task URL is `/projects/<projectId>/tasks/<taskId>`.

Create the bounded fixture with the CLI procedure in the test-loop reference;
do not assume the website has a Create task button. Compare the detail page with:

```bash
DN_CONFIG_DIR="$DN_DEV_ROOT" "$DN_DEV_CLI" task show "$DN_TASK_ID" \
  --project "$DN_PROJECT_ID" --json
```

The detail tabs are Overview (`概览`), Attachments (`附件`), Steps (`步骤`),
Discussion (`讨论`) and, when an execution supplies it, Session. The corresponding
query values are `overview`, `attachments`, `steps`, `discussion` and `session`;
for example, append `?tab=attachments` to the task URL. Overview is the default.
Steps describe work inside a task; they are not separate schedulable tasks.
Do not add steps or discussion posts merely to navigate the fixture.

## Enable the fixture through the website

For the test loop, explicitly create the confirmed fixture with `--status todo`; it is assigned to the signed-in
account, with `allowAgents=false`. Confirm these facts before enabling it. The
Ready/Blocked indication describes dependency readiness, not a running Agent.

Review the assignee and required platform in the detail header before dispatch.
Changing the assignee disables automatic execution. A platform requirement is
not a machine assignment; the isolated Worker selection in the test-loop
procedure still applies. Platform changes have their own confirmation dialog.

Click Automatic execution (`自动执行`), then confirm Enable automatic execution
(`开启自动执行`) in its confirmation, which has the `alertdialog` role rather
than `dialog`. The successful setting notice proves the permission was saved,
not that a Worker has claimed the task. Read the same task with the CLI and
confirm `allowAgents=true`. It may already be `in_progress`; do not require the
version to increase by exactly one or the task to remain `todo`.

Automatic execution, assignee and platform changes are locked during
`in_progress`. Stale data, a pending operation or insufficient access can also
disable controls. Do not force a status change or withdraw a claim just to make
the switch available. For this fixture, the Worker performs the real claim and
the managed Agent completes that original claim.

## Verify the intended Worker's configuration

Open My Workers (`我的 Worker`) at `/workers`, find the expected machine and use
View details (`查看详情`). Match the full Worker ID, platform and repository
observations at `/workers/<workerId>`, not only its display name. The list covers
recently reported Workers; online and idle-looking data are observations with
timestamps, not guarantees of current capacity.

The runtime overview can be compared with these read-only CLI observations:

```bash
DN_CONFIG_DIR="$DN_DEV_ROOT" "$DN_DEV_CLI" worker list --json
DN_CONFIG_DIR="$DN_DEV_ROOT" "$DN_DEV_CLI" worker show "$DN_WORKER_ID" --json
```

`worker show` does not return the cloud configuration document. Where the running
revision supports it, open Configuration (`配置`) to inspect Agent, model,
arguments, concurrency, polling and selected projects. Repository paths, Worker
identity, service credentials and `agentControlMode` remain local settings;
selecting Codex on this page does not select Web mode.

For an authorized test-configuration change:

1. Review the complete existing project selection and active executions first.
2. Use Choose projects (`选择项目`), search by project name, repository or ID,
   and select the intended local project. Done (`完成`) closes the chooser and
   updates only the draft.
3. Review the draft, including inherited and project-specific Agent settings.
   Click Save configuration (`保存配置`) to submit it.
4. Inspect Configuration status (`配置状态`): target version, application report
   time, actual values and individual application results. Require the relevant
   settings to be Applied (`已生效`) at the intended version before dispatch.

Draft, saved and applied are distinct states. A saved notice can precede Worker
application; an offline Worker waits until it reconnects. Failure or partial
application must remain visible in the result. Configuration management is not
connected (`尚未接入配置管理`) requires a compatible enrolled Worker, not repeated
saves. Removing a project stops its executions while retaining task state,
claims, workspaces and history. Preserve existing projects; removal is not a
refresh mechanism or a way to isolate a shared test pool.

## Observe the Session without confusing it with task state

Open the fixture's Session tab when available and match its current execution
with the observed Worker claim. No associated execution means the tab can be
absent; requesting `?tab=session` then falls back to Overview. A waiting task
without a Session is not itself a Session failure.

The view distinguishes registration, startup, synchronization, connection and
failure states. Read the displayed state before treating an empty timeline as a
failure. Existing history can be visible while new input is unavailable.
Display (`显示`) switches Standard/Conversation presentation; Session fullscreen
(`会话全屏`) expands the view within the browser content area. Neither action
starts an Agent.

Execution record (`执行记录`) selects the current execution or available history.
Archived history is read-only. Task completion alone proves neither archive
readiness nor worktree deletion. The test loop requires actual Agent execution
and result readback; Session View supplies supporting observations.

The Message (`消息`) input uses `Send` when idle and `Add to current turn` while
working. Interruption uses `Interrupt`, `Interrupting…` or `Interrupt requested`.
These native action labels remain English in every UI locale. Use actions and
confirmation cards only when the test requires them; reconcile uncertain input
before resending. Enter sends; Shift+Enter inserts a newline.

The separate `/test-sessions` page lists online test sessions. Its empty-state
creation command is `daynight controller codex`; these sessions are not Worker
claims and cannot replace the managed execution in the test loop. Start, drive
and stop them under [controller Test Sessions](test-sessions.md).

## Read the result attachment in both clients

Open Attachments (`附件`), use Refresh attachments (`刷新附件`) when needed, then
expand the `acceptance` folder, which the file tree shows collapsed, and select
`result.md`. Check the run marker and actual
routing/build evidence against the same task's CLI output:

```bash
DN_CONFIG_DIR="$DN_DEV_ROOT" "$DN_DEV_CLI" task attachment list "$DN_TASK_ID" \
  --project "$DN_PROJECT_ID" --json
DN_CONFIG_DIR="$DN_DEV_ROOT" "$DN_DEV_CLI" task attachment read "$DN_TASK_ID" \
  acceptance/result.md --project "$DN_PROJECT_ID"
```

Require a successful read exit status; failed CLI reads can leave partial bytes
on stdout. The preview offers Download (`下载`) and Open in new tab
(`在新标签页打开`). For a direct attachment URL, append `/attachments/` and the
relative path to the task URL, encoding each path segment separately.

If upload is part of the authorized acceptance, expand Upload file (`上传文件`),
choose one file, review Target relative path (`目标相对路径`), then submit Upload
file. Paths are case-sensitive and use `/`. The same path replaces the existing
attachment, so use a unique test path and inspect it before writing. The file's
More actions (`更多操作`) menu exposes deletion with a separate confirmation.
The standard loop only needs to read the Agent's result; it does not require
overwriting or deleting attachments.

## Reconcile uncertain results and report the loop

For an uncertain task mutation, use Check actual task (`核对实际任务`) and read
the same task ID with the CLI. A version conflict means the task changed; review
its current state before deciding whether the original action is still needed.
Do not create another fixture or blindly repeat a write.

For uncertain Worker configuration saves, use Check save result (`核对保存结果`).
On a conflict, inspect the latest cloud configuration and preserve the intended
draft until differences are understood. A confirmed save still needs the
matching Worker application report. For Session actions, use the offered
original-operation check. For attachment writes, reread the exact path and bytes
before deciding whether another upload is needed.

Report browser observations separately from CLI and runtime evidence. Full
success requires CLI creation, website read/enablement, CLI readback, the expected
Worker's managed execution and matching result readback in both clients. Retain
the localhost fixture and attachment by default. Deletion, forced completion,
claim withdrawal and shared-data cleanup are not recovery steps for this guide.
