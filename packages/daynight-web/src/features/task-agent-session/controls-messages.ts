import { useI18n } from '../../i18n/LocaleProvider';
import type { SessionNativeCommand, SessionSetting } from '../../../../daynight/src/session/controls';

const en = {
  model: 'Model', effort: 'Reasoning effort', approval: 'Approval policy', sandbox: 'Sandbox', permissions: 'Permissions', toolApproval: 'Tool approvals',
  untrusted: 'Untrusted', onRequest: 'On request', never: 'Never ask', readOnly: 'Read only', workspaceWrite: 'Workspace write', fullAccess: 'Full access',
  askPermissions: 'Ask for permissions', acceptEdits: 'Accept edits', denyUnapproved: 'Deny unapproved tools', plan: 'Plan', bypassPermissions: 'Full access (YOLO)',
  askApproval: 'Ask for approval', allowTools: 'Allow tools', nativeDefault: 'Native default',
  codexModel: 'Changes subsequent native steps when supported, and future turns.',
  codexEffort: 'The native model defines supported effort levels.',
  codexApproval: 'Approval policy for subsequent turns. Sandbox restrictions remain independent.',
  codexSandbox: 'Native sandbox for subsequent turns. Full access removes filesystem and network restrictions.',
  claudeModel: 'Applies to subsequent native requests. Default follows Claude Code.',
  claudeEffort: 'Applies to subsequent native requests. Native default clears the effort override.',
  claudePermissions: 'Native permission mode. Full access runs tools without asking and disables the sandbox.',
  copilotModel: 'Native model switches can remain queued until the current turn finishes.',
  copilotEffort: 'Omitted effort follows native defaults. Changes apply to subsequent turns.',
  copilotApproval: 'Native tool approval policy. Existing grants, path and network permissions are independent.',
  compact: 'Compact the current Codex thread', prompt: 'Custom Codex prompt', codexSkill: 'Codex skill', claudeCommand: 'Claude command', copilotSkill: 'Copilot skill',
};
type MessageKey = keyof typeof en;
type ControlMessages = { readonly [K in MessageKey]: string };
const zh: ControlMessages = {
  model: '模型', effort: '推理强度', approval: '审批策略', sandbox: '沙箱', permissions: '权限', toolApproval: '工具审批',
  untrusted: '仅信任的命令免审批', onRequest: '按需请求审批', never: '从不请求审批', readOnly: '只读', workspaceWrite: '工作区写入', fullAccess: '完全访问',
  askPermissions: '请求权限', acceptEdits: '允许编辑', denyUnapproved: '拒绝未经批准的工具', plan: '计划', bypassPermissions: '完全访问（YOLO）',
  askApproval: '请求审批', allowTools: '允许工具', nativeDefault: '原生默认',
  codexModel: '在支持时更改后续原生步骤，并应用于后续轮次。',
  codexEffort: '原生模型定义支持的推理强度。',
  codexApproval: '后续轮次的审批策略。沙箱限制独立生效。',
  codexSandbox: '后续轮次的原生沙箱。完全访问会移除文件系统和网络限制。',
  claudeModel: '应用于后续原生请求。默认模型由 Claude Code 决定。',
  claudeEffort: '应用于后续原生请求。原生默认会清除推理强度覆盖。',
  claudePermissions: '原生权限模式。完全访问无需询问即可运行工具，并禁用沙箱。',
  copilotModel: '原生模型切换可能排队等待当前轮次结束。',
  copilotEffort: '未指定推理强度时使用原生默认值。更改应用于后续轮次。',
  copilotApproval: '原生工具审批策略。已有授权、路径权限和网络权限独立生效。',
  compact: '压缩当前 Codex 会话', prompt: '自定义 Codex 提示词', codexSkill: 'Codex 技能', claudeCommand: 'Claude 命令', copilotSkill: 'Copilot 技能',
};

type SettingMessages = { readonly label: MessageKey; readonly description: MessageKey; readonly options?: Readonly<Record<string, MessageKey>> };
const settings: Readonly<Record<string, Readonly<Record<string, SettingMessages>>>> = {
  codex: {
    model: { label: 'model', description: 'codexModel' },
    effort: { label: 'effort', description: 'codexEffort' },
    approval: { label: 'approval', description: 'codexApproval', options: { untrusted: 'untrusted', 'on-request': 'onRequest', never: 'never' } },
    sandbox: { label: 'sandbox', description: 'codexSandbox', options: { readOnly: 'readOnly', workspaceWrite: 'workspaceWrite', dangerFullAccess: 'fullAccess' } },
  },
  claude: {
    model: { label: 'model', description: 'claudeModel' },
    effort: { label: 'effort', description: 'claudeEffort', options: { default: 'nativeDefault' } },
    permissions: { label: 'permissions', description: 'claudePermissions', options: { default: 'askPermissions', acceptEdits: 'acceptEdits', dontAsk: 'denyUnapproved', plan: 'plan', bypassPermissions: 'bypassPermissions' } },
  },
  copilot: {
    model: { label: 'model', description: 'copilotModel' },
    effort: { label: 'effort', description: 'copilotEffort' },
    tool_approval: { label: 'toolApproval', description: 'copilotApproval', options: { ask: 'askApproval', allow: 'allowTools' } },
  },
};
const own = <T,>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined => record && Object.hasOwn(record, key) ? record[key] : undefined;

export function useSessionControlMessages(provider: string | undefined) {
  const messages = useI18n().locale === 'zh-CN' ? zh : en;
  const settingMessages = (setting: SessionSetting) => own(own(settings, provider ?? ''), setting.id);
  return {
    settingLabel(setting: SessionSetting) {
      const entry = settingMessages(setting);
      return entry ? messages[entry.label] : setting.label;
    },
    settingDescription(setting: SessionSetting) {
      const entry = settingMessages(setting);
      return entry && setting.description !== null ? messages[entry.description] : setting.description;
    },
    optionLabel(setting: SessionSetting, option: SessionSetting['options'][number]) {
      const key = own(settingMessages(setting)?.options, option.value);
      return key ? messages[key] : option.label;
    },
    commandDescription(command: SessionNativeCommand) {
      // Legacy catalogs have no text provenance. Match only adapter-owned IDs
      // and exact fallback text; all other provider descriptions stay verbatim.
      let key: MessageKey | undefined;
      if (provider === 'codex') {
        if (command.id === 'compact' && command.name === 'compact') key = 'compact';
        else if (command.id.startsWith('prompt:') && command.name === `prompts:${command.id.slice(7)}`) key = 'prompt';
        else if (command.id.startsWith('skill:')) key = 'codexSkill';
      } else if (provider === 'claude' && command.id === `claude:${command.name}`) key = 'claudeCommand';
      else if (provider === 'copilot') key = 'copilotSkill';
      return key && command.description === en[key] ? messages[key] : command.description;
    },
  };
}
