import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ProjectWebhookInput, ProjectWebhookStatus } from '../../api/github-consumption';
import { useI18n } from '../../i18n/LocaleProvider';
import { CopyButton } from '../../ui/copy-button/CopyButton';
import { ManagementDialog } from '../management/ManagementDialog';
import './project-webhook.css';

const copy = {
  'zh-CN': {
    title: '项目 Webhook', unconfigured: '未配置', disabled: '已停用', repository_mismatch: '仓库不匹配', waiting: '等待投递', received: '已收到投递',
    unconfiguredHelp: '配置仓库 Webhook，在 GitHub 发送事件时触发 PR 同步。', disabledHelp: '新事件不会触发同步；启用 PR 同步时周期轮询继续。', mismatchHelp: '请为当前连接的仓库重新配置 Webhook。旧仓库的投递不会触发更新。', waitingHelp: '在 GitHub 保存后，有效的 ping 或 pull request 事件可确认配置。', receivedHelp: 'GitHub 已向此地址投递有效事件；PR 同步结果单独显示。',
    url: 'Payload URL', copyUrl: '复制 URL', setup: '在 GitHub 仓库的 Settings → Webhooks 中选择 application/json 和 Pull requests 事件，并填写相同的 secret。可在 GitHub 的投递记录中查看结果。', copied: '已复制。', copyFailed: '复制失败，请检查浏览器权限并重试。',
    last: '最近有效投递', never: '尚无', repository: 'Webhook 仓库', configure: '配置 Webhook', reconfigure: '重新配置 Webhook', change: '更换 secret', disable: '停用 Webhook', enable: '启用 Webhook',
    configureTitle: '配置项目 Webhook', reconfigureTitle: '重新配置项目 Webhook', changeTitle: '更换 Webhook secret', disableTitle: '停用项目 Webhook', enableTitle: '启用项目 Webhook', target: '项目仓库',
    secret: 'Webhook secret', secretHint: '生成 secret 或输入自己的 secret。在 GitHub 使用相同的值；Daynight 不显示已保存的 secret。', invalidSecret: '请输入有效的 secret，最多 4,096 字节。', generate: '生成随机 secret', generated: '已生成随机 secret，请在保存前复制。', generationFailed: '无法生成随机 secret，请输入自己的 secret。', copySecret: '复制 secret', secretCopied: '已复制 secret。',
    disableHelp: '新投递不会触发 PR 更新；启用 PR 同步时周期轮询继续。', enableHelp: '下一次有效投递将确认此配置。', cancel: '取消', save: '保存 Webhook', saving: '保存中…', retry: '检查当前设置',
    conflict: 'Webhook 设置已更改。请检查当前配置，草稿会保留。', unknown: '保存结果未知。请检查当前设置；安全状态无法确认 secret 是否保存。', writeError: '操作未完成，请检查后重试。', readError: '无法读取当前设置，请重试。', unknownChecked: '已检查当前设置；无法确认 secret 是否保存。', saved: 'Webhook 设置已保存。', current: '当前版本',
  },
  en: {
    title: 'Project webhook', unconfigured: 'Not configured', disabled: 'Disabled', repository_mismatch: 'Repository mismatch', waiting: 'Waiting for delivery', received: 'Delivery received',
    unconfiguredHelp: 'Configure a repository webhook to trigger PR sync when GitHub sends an event.', disabledHelp: 'New events do not trigger sync. Scheduled polling continues while PR sync is enabled.', mismatchHelp: 'Configure a webhook for the currently connected repository. Old-repository deliveries cannot trigger updates.', waitingHelp: 'After saving in GitHub, a valid ping or pull request event confirms the configuration.', receivedHelp: 'GitHub reached this endpoint. PR sync results are shown separately.',
    url: 'Payload URL', copyUrl: 'Copy URL', setup: 'In the GitHub repository, go to Settings → Webhooks. Select application/json and the Pull requests event, and enter the same secret. Check GitHub delivery records for results.', copied: 'Copied.', copyFailed: 'Could not copy. Check browser permissions and try again.',
    last: 'Last valid delivery', never: 'Never', repository: 'Webhook repository', configure: 'Configure webhook', reconfigure: 'Reconfigure webhook', change: 'Change secret', disable: 'Disable webhook', enable: 'Enable webhook',
    configureTitle: 'Configure project webhook', reconfigureTitle: 'Reconfigure project webhook', changeTitle: 'Change webhook secret', disableTitle: 'Disable project webhook', enableTitle: 'Enable project webhook', target: 'Project repository',
    secret: 'Webhook secret', secretHint: 'Generate a secret or enter your own. Use the same secret in GitHub. Daynight does not display saved secrets.', invalidSecret: 'Enter a valid secret of at most 4,096 bytes.', generate: 'Generate random secret', generated: 'Random secret generated. Copy it before saving.', generationFailed: 'Could not generate a random secret. Enter your own secret.', copySecret: 'Copy secret', secretCopied: 'Secret copied.',
    disableHelp: 'New deliveries will not trigger PR updates. Scheduled polling continues while PR sync is enabled.', enableHelp: 'The next valid delivery will confirm this configuration.', cancel: 'Cancel', save: 'Save webhook', saving: 'Saving…', retry: 'Check current settings',
    conflict: 'Someone changed the webhook settings. Check the current configuration; your draft is retained.', unknown: 'The save result is unknown. Check the current settings; the safe status cannot confirm whether the secret was saved.', writeError: 'The operation did not complete. Check and try again.', readError: 'Could not read the current settings. Try again.', unknownChecked: 'Current settings checked; the secret save result cannot be confirmed.', saved: 'Webhook settings saved.', current: 'Current version',
  },
} as const;

type Result = 'saved' | 'conflict' | 'unknown' | 'error';
type Props = {
  readonly status: ProjectWebhookStatus;
  readonly repository: { readonly id: string; readonly fullName: string } | null;
  readonly admin: boolean;
  readonly blocked: boolean;
  readonly suspended: boolean;
  readonly save: (input: ProjectWebhookInput) => Promise<Result>;
  readonly reload: () => Promise<ProjectWebhookStatus | null>;
  readonly onStateChange?: (state: { dirty: boolean; pending: boolean; needsAttention: boolean }) => void;
  readonly onRetentionChange?: (retain: boolean) => void;
};

type Action = 'secret' | 'toggle';
type Issue = 'conflict' | 'unknown' | 'error' | null;

export const ProjectWebhookPanel = ({ status, repository, admin, blocked, suspended, save, reload, onStateChange, onRetentionChange }: Props) => {
  const { locale, format } = useI18n();
  const m = copy[locale];
  const [action, setAction] = useState<Action | null>(null);
  const [secret, setSecret] = useState('');
  const [draftVersion, setDraftVersion] = useState<string | null>(null);
  const [issue, setIssue] = useState<Issue>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [secretFeedback, setSecretFeedback] = useState('');
  const [feedback, setFeedback] = useState('');
  const generation = useRef(0);
  const secretRef = useRef(secret); secretRef.current = secret;
  const actionRef = useRef(action); actionRef.current = action;
  const mounted = useRef(true);
  useLayoutEffect(() => { onStateChange?.({ dirty: action === 'secret' && secret.length > 0, pending, needsAttention: issue !== null }); }, [action, secret, pending, issue, onStateChange]);
  useLayoutEffect(() => { onRetentionChange?.(pending || issue === 'conflict' || issue === 'unknown'); }, [pending, issue, onRetentionChange]);
  useEffect(() => () => { mounted.current = false; generation.current++; }, []);
  const close = () => { generation.current++; setAction(null); setSecret(''); setSecretFeedback(''); setIssue(null); setReadFailed(false); setPending(false); };
  useEffect(() => { if (!admin) close(); }, [admin]);
  useEffect(() => {
    if (action !== null && !pending && issue === null && status.version !== draftVersion) setIssue('conflict');
  }, [action, status.version, draftVersion, pending, issue]);
  const open = (next: Action) => {
    if (!admin || blocked || pending) return;
    generation.current++; setAction(next); setDraftVersion(status.version); setSecret(''); setIssue(null); setReadFailed(false); setSecretFeedback(''); setFeedback('');
  };
  const valid = secret.length > 0 && secret.isWellFormed() && new TextEncoder().encode(secret).length <= 4096;
  const canEdit = repository !== null;
  const canToggle = status.enabled || canEdit && repository?.id === status.repositoryId;
  const help = status.state === 'unconfigured' ? m.unconfiguredHelp : status.state === 'disabled' ? m.disabledHelp : status.state === 'repository_mismatch' ? m.mismatchHelp : status.state === 'waiting' ? m.waitingHelp : m.receivedHelp;
  const editLabel = status.state === 'repository_mismatch' ? m.reconfigure : status.version === null ? m.configure : m.change;
  const dialogTitle = action === 'secret' ? status.state === 'repository_mismatch' ? m.reconfigureTitle : status.version === null ? m.configureTitle : m.changeTitle : status.enabled ? m.disableTitle : m.enableTitle;
  const copyText = async (value: string, secretCopy: boolean) => {
    const ticket = generation.current;
    try {
      await navigator.clipboard.writeText(value);
      if (!mounted.current || ticket !== generation.current || secretCopy && (actionRef.current === null || secretRef.current !== value)) return;
      if (secretCopy) setSecretFeedback(m.secretCopied); else setFeedback(m.copied);
    } catch {
      if (!mounted.current || ticket !== generation.current || secretCopy && (actionRef.current === null || secretRef.current !== value)) return;
      if (secretCopy) setSecretFeedback(m.copyFailed); else setFeedback(m.copyFailed);
    }
  };
  const generate = () => {
    try {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      setSecret(Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')); setSecretFeedback(m.generated);
    } catch { setSecretFeedback(m.generationFailed); }
  };
  const submit = async () => {
    if (action === null || !admin || blocked || pending || issue === 'conflict' || issue === 'unknown' || status.version !== draftVersion) return;
    if (action === 'secret' && (!valid || repository === null) || action === 'toggle' && !canToggle) return;
    const ticket = generation.current;
    const input: ProjectWebhookInput = action === 'secret'
      ? { version: draftVersion, enabled: status.version === null ? true : status.enabled, repositoryId: repository!.id, secret }
      : { version: draftVersion, enabled: !status.enabled };
    setPending(true); setIssue(null); setReadFailed(false);
    let result: Result;
    try { result = await save(input); } catch { result = 'unknown'; }
    if (!mounted.current || ticket !== generation.current) return;
    setPending(false);
    if (result === 'saved') { close(); setFeedback(m.saved); }
    else setIssue(result);
  };
  const check = async () => {
    if (pending) return;
    const ticket = generation.current; setPending(true); setReadFailed(false);
    let current: ProjectWebhookStatus | null;
    try { current = await reload(); } catch { current = null; }
    if (!mounted.current || ticket !== generation.current) return;
    setPending(false);
    if (current === null) { setReadFailed(true); return; }
    if (issue === 'unknown') { close(); setFeedback(m.unknownChecked); }
    else { setDraftVersion(current.version); setIssue(null); }
  };
  return <section className="project-webhook" aria-labelledby="project-webhook-title">
    <div className="github-channel-heading"><h3 id="project-webhook-title">{m.title}</h3><span className={`badge ${status.state === 'received' ? 'success' : status.state === 'waiting' || status.state === 'repository_mismatch' ? 'warning' : ''}`} role="status">{m[status.state]}</span></div>
    <p className="github-member-hint">{help}</p>
    <div className="field"><label htmlFor="project-webhook-url">{m.url}</label><div className="project-webhook-url"><input id="project-webhook-url" value={status.webhookUrl} readOnly /><CopyButton label={m.copyUrl} onClick={() => { void copyText(status.webhookUrl, false); }}>{m.copyUrl}</CopyButton></div><p className="hint">{m.setup}</p></div>
    {status.version !== null && <dl className="github-details project-webhook-facts"><div><dt>{m.last}</dt><dd>{status.lastReceivedAt === null ? m.never : format.dateTime(status.lastReceivedAt)}</dd></div><div><dt>{m.repository}</dt><dd>{status.repositoryId === repository?.id ? repository.fullName : status.repositoryId}</dd></div></dl>}
    {admin && <div className="project-webhook-actions"><button type="button" className="button primary" disabled={blocked || !canEdit} onClick={() => open('secret')}>{editLabel}</button>{status.version !== null && <button type="button" className="button" disabled={blocked || !canToggle} onClick={() => open('toggle')}>{status.enabled ? m.disable : m.enable}</button>}</div>}
    {feedback && <p role="status">{feedback}</p>}
    {action !== null && <ManagementDialog title={dialogTitle} suspended={suspended} busy={pending} initialFocus={action === 'secret' ? 'input' : 'cancel'} onClose={close} footer={<><button className="button" type="button" data-dialog-cancel disabled={pending} onClick={close}>{m.cancel}</button><button className="button primary" type="button" disabled={pending || blocked || issue === 'conflict' || issue === 'unknown' || (action === 'secret' && !valid)} onClick={() => { void submit(); }}>{pending ? m.saving : action === 'secret' ? m.save : status.enabled ? m.disable : m.enable}</button></>}>
      <div className="github-dialog-target"><span className="small-label">{m.target}</span><strong>{repository?.fullName ?? status.repositoryId}</strong></div>
      {action === 'secret' ? <div className="field"><label htmlFor="project-webhook-secret">{m.secret}</label><input id="project-webhook-secret" type="password" autoComplete="off" disabled={pending} value={secret} aria-describedby="project-webhook-secret-hint" aria-invalid={secret.length > 0 && !valid} onChange={event => { setSecret(event.target.value); setSecretFeedback(''); }} /><div className="project-webhook-actions project-webhook-secret-actions"><button type="button" className="button" disabled={pending} onClick={generate}>{m.generate}</button><CopyButton label={m.copySecret} disabled={pending || !valid} onClick={() => { void copyText(secret, true); }}>{m.copySecret}</CopyButton></div><p className="hint" id="project-webhook-secret-hint">{secret.length > 0 && !valid ? m.invalidSecret : m.secretHint}</p><p className="hint" role="status">{secretFeedback}</p></div> : <p>{status.enabled ? m.disableHelp : m.enableHelp}</p>}
      {issue !== null && <div className="notice warning" role="alert"><p>{issue === 'conflict' ? m.conflict : issue === 'unknown' ? m.unknown : m.writeError}</p>{issue !== 'error' && <><p>{m.current}: {status.version ?? '—'}</p><button className="button" type="button" disabled={pending} onClick={() => { void check(); }}>{m.retry}</button></>}{readFailed && <p>{m.readError}</p>}</div>}
    </ManagementDialog>}
  </section>;
};
