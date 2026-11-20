import { useRef, useEffect } from 'react';
import type { ScopeCatalog } from '../../api/credential-scope';
import { useI18n } from '../../i18n/LocaleProvider';
import type { Locale } from '../../i18n/locale';
import './credential-scope-selector.css';

// Labels describe the actual catalog IDs, not reusable grants or future group members.
const groups: Record<string, readonly [string, string]> = {
  task: ['任务', 'Tasks'], step: ['Steps', 'Steps'], thread: ['任务讨论', 'Task discussions'], attachment: ['附件', 'Attachments'],
  agent: ['Agent 执行许可', 'Agent execution permission'], 'worker-execution': ['Worker 执行', 'Worker execution'], 'worker-management': ['Worker 管理', 'Worker management'],
  session: ['会话', 'Sessions'], project: ['项目', 'Projects'], team: ['Team', 'Teams'], tag: ['标签', 'Tags'], bot: ['Bot', 'Bots'],
  'assistant-task': ['Assistant Task', 'Assistant Tasks'], webhook: ['Webhook', 'Webhooks'], account: ['账户资料', 'Account profile'], prompt: ['提示词', 'Prompts'], usage: ['用量', 'Usage'], github: ['GitHub 集成', 'GitHub integration'],
};
const labels: Record<string, readonly [string, string]> = {
  'task:read': ['查看任务及依赖', 'View tasks and dependencies'], 'task:write': ['创建任务及编辑基本信息、普通属性和标签关联', 'Create tasks and edit basic details, ordinary properties and tag associations'], 'task:assign': ['修改负责人和执行平台', 'Change assignee and execution platform'], 'task:dependencies': ['修改依赖和父 Goal', 'Edit dependencies and parent Goal'], 'task:status': ['变更任务状态及阻塞执行的控制属性', 'Change task status and execution-blocking control properties'], 'task:delete': ['删除任务或 Goal', 'Delete tasks or Goals'],
  'step:read': ['查看 Steps', 'View Steps'], 'step:write': ['编辑 Steps', 'Edit Steps'], 'thread:read': ['阅读讨论', 'Read discussions'], 'thread:post': ['在讨论中发帖', 'Post to discussions'],
  'attachment:read': ['查看和下载附件', 'View and download attachments'], 'attachment:upload': ['上传附件', 'Upload attachments'], 'attachment:delete': ['删除附件', 'Delete attachments'], 'agent:authorize': ['开启或关闭任务的 Agent 执行许可', 'Change task Agent execution permission'],
  'worker:claim': ['领取任务', 'Claim tasks'], 'worker:release': ['释放任务', 'Release tasks'], 'worker:complete': ['完成已领取的任务', 'Complete claimed tasks'], 'worker:retry': ['重试或恢复运行', 'Retry or recover execution'], 'worker:recover': ['恢复执行资源', 'Recover execution resources'], 'worker:report': ['上报 Worker 运行状态', 'Report Worker execution status'],
  'worker:read': ['查看 Worker 和监控信息', 'View Workers and monitoring'], 'worker:configure': ['配置 Worker', 'Configure Workers'], 'worker:inspect': ['检查在线 Worker 资源', 'Inspect online Worker resources'],
  'session:read': ['查看会话状态和历史', 'View session status and history'], 'session:send': ['向会话发消息', 'Send messages to sessions'], 'session:control': ['审批响应、取消或停止会话', 'Respond to approvals, cancel or stop sessions'], 'session:produce': ['注册会话和生成会话资源', 'Register sessions and produce session resources'], 'session:delete': ['删除会话资源', 'Delete session resources'],
  'project:read': ['查看项目', 'View projects'], 'project:write': ['创建和编辑项目', 'Create and edit projects'], 'project:members': ['管理项目成员', 'Manage project members'], 'project:invitations': ['管理发出的项目邀请', 'Manage sent project invitations'], 'project:invitation-read': ['查看收到的项目邀请', 'View received project invitations'], 'project:invitation-accept': ['接受收到的项目邀请', 'Accept received project invitations'], 'project:repository': ['切换项目仓库', 'Switch project repositories'], 'project:transfer': ['转移项目', 'Transfer projects'], 'project:delete': ['删除项目', 'Delete projects'],
  'team:read': ['查看 Team', 'View Teams'], 'team:write': ['创建和改名 Team', 'Create and rename Teams'], 'team:members': ['管理 Team 成员', 'Manage Team members'], 'team:invitations': ['管理发出的 Team 邀请', 'Manage sent Team invitations'], 'team:invitation-read': ['查看收到的 Team 邀请', 'View received Team invitations'], 'team:invitation-accept': ['接受收到的 Team 邀请', 'Accept received Team invitations'], 'team:leave': ['退出 Team', 'Leave Teams'], 'team:delete': ['删除 Team', 'Delete Teams'],
  'tag:read': ['查看标签', 'View tags'], 'tag:write': ['创建和编辑标签', 'Create and edit tags'], 'tag:delete': ['删除标签', 'Delete tags'], 'bot:read': ['查看 Bot 定义', 'View Bot definitions'], 'bot:write': ['创建和编辑 Bot 定义', 'Create and edit Bot definitions'], 'bot:delete': ['删除 Bot 定义', 'Delete Bot definitions'],
  'assistant-task:read': ['查看 Assistant Task', 'View Assistant Tasks'], 'assistant-task:write': ['编辑 Assistant Task 和材料', 'Edit Assistant Tasks and materials'], 'assistant-task:operate': ['操作 Assistant Task', 'Operate Assistant Tasks'], 'assistant-task:delete': ['删除 Assistant Task', 'Delete Assistant Tasks'], 'assistant-task:inbox': ['管理 Assistant Task Inbox', 'Manage Assistant Task Inbox'],
  'webhook:read': ['查看 Webhook 配置和投递', 'View Webhook configuration and deliveries'], 'webhook:write': ['创建和编辑 Webhook（启用、改向或扩张订阅另需投递权限）', 'Create and edit Webhooks (enabling, retargeting or expanding subscriptions also requires delivery permission)'], 'webhook:delete': ['删除 Webhook', 'Delete Webhooks'], 'webhook:secret': ['查看和轮换 Webhook 密钥', 'View and rotate Webhook secrets'], 'webhook:deliver': ['启用或重发投递、改向或扩张订阅', 'Enable or retry deliveries, change destinations or expand subscriptions'],
  'account:write': ['编辑账户资料', 'Edit account profile'], 'prompt:read': ['查看提示词', 'View prompts'], 'prompt:write': ['编辑提示词', 'Edit prompts'], 'usage:read': ['查看用量', 'View usage'], 'github:read': ['查看 GitHub 集成', 'View GitHub integration'], 'github:manage': ['管理 GitHub 集成', 'Manage GitHub integration'],
};
const textFor = (values: Record<string, readonly [string, string]>, key: string, locale: Locale) => values[key]?.[locale === 'zh-CN' ? 0 : 1];

export const credentialScopeLabel = (id: string, locale: Locale): string | undefined => textFor(labels, id, locale);

export const hasCredentialScopeLabels = (catalog: ScopeCatalog, locale: Locale): boolean => catalog.groups.every(group =>
  Boolean(textFor(groups, group.id, locale)) && group.scopeIds.every(id => Boolean(textFor(labels, id, locale))));

const GroupCheck = ({ checked, partial, disabled, label, onChange }: { checked: boolean; partial: boolean; disabled: boolean; label: string; onChange: (checked: boolean) => void }) => {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = partial; }, [partial]);
  return <label className="credential-scope-option credential-scope-all"><input ref={ref} type="checkbox" checked={checked} disabled={disabled} aria-label={label} onChange={event => onChange(event.currentTarget.checked)} /><span>{label}</span></label>;
};

export const CredentialScopeSelector = ({ catalog, selected, onChange, disabled = false }: { catalog: ScopeCatalog; selected: readonly string[]; onChange: (scopes: string[]) => void; disabled?: boolean }) => {
  const { locale } = useI18n();
  const selection = new Set(selected);
  const available = catalog.groups.flatMap(group => group.scopeIds);
  const count = available.filter(id => selection.has(id)).length;
  const update = (ids: readonly string[], checked: boolean) => {
    const next = new Set(selected);
    for (const id of ids) { if (checked) next.add(id); else next.delete(id); }
    onChange([...available.filter(id => next.has(id)), ...selected.filter(id => !available.includes(id) && next.has(id))]);
  };
  return <section className="credential-scopes" aria-label={locale === 'zh-CN' ? '访问权限' : 'Access permissions'}>
    <div className="credential-scope-top"><h2>{locale === 'zh-CN' ? '访问权限' : 'Access permissions'}</h2><output aria-live="polite">{locale === 'zh-CN' ? `已选 ${count}` : `Selected ${count}`}</output></div>
    <div className="credential-scope-list">{catalog.groups.map(group => {
      const name = textFor(groups, group.id, locale) ?? group.id;
      const groupCount = group.scopeIds.filter(id => selection.has(id)).length;
      const selectGroup = locale === 'zh-CN' ? `全选本组 · ${name}` : `Select this group · ${name}`;
      return <details className="credential-scope-group" key={group.id}>
        <summary><span className="credential-scope-chevron" aria-hidden="true" /><span className="credential-scope-group-name">{name}</span><code>{group.id}</code><span className="credential-scope-group-count">{groupCount} / {group.scopeIds.length}</span></summary>
        <div className="credential-scope-options"><GroupCheck checked={groupCount === group.scopeIds.length && groupCount > 0} partial={groupCount > 0 && groupCount < group.scopeIds.length} disabled={disabled} label={selectGroup} onChange={checked => update(group.scopeIds, checked)} />
          {group.scopeIds.map(id => <label className="credential-scope-option" key={id}><input type="checkbox" checked={selection.has(id)} disabled={disabled} onChange={event => update([id], event.currentTarget.checked)} /><span className="credential-scope-option-text"><span>{textFor(labels, id, locale) ?? id}</span><code>{id}</code></span></label>)}
        </div>
      </details>;
    })}</div>
  </section>;
};
