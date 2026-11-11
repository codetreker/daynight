import { useI18n } from '../../i18n/LocaleProvider';
import type { BotSelectionSource } from '../../api/bots';

const en = {
  defaultConfiguration: 'Default configuration', customConfiguration: 'Custom configuration', configurationDetails: 'Configuration details',
  browse: 'Browse', defaultDirectory: 'Use Worker default directory', defaultValue: 'Use default', resetAll: 'Restore all defaults',
  model: 'Model', effort: 'Reasoning effort', modelError: 'Could not read model capabilities.', noEfforts: 'This model does not expose reasoning effort choices.', unknownEfforts: 'Reasoning effort capabilities are not known for this model.',
  confirmedCreation: 'Assistant creation confirmed.', openCreated: 'Open assistant',
  unknownValue: 'Not reported', nativeValue: 'Agent configuration',
  sources: { explicit: 'Explicit selection', preference: 'Successful preference', local: 'Local configuration', cloud: 'Cloud configuration', native: 'Agent configuration', unknown: 'Source not reported' } as Record<BotSelectionSource, string>,
};
const zh: typeof en = {
  defaultConfiguration: '默认配置', customConfiguration: '自定义配置', configurationDetails: '配置详情',
  browse: '浏览', defaultDirectory: '使用 Worker 默认目录', defaultValue: '使用默认', resetAll: '恢复全部默认',
  model: 'Model', effort: 'Reasoning effort', modelError: '无法读取模型能力。', noEfforts: '此模型未提供推理强度选项。', unknownEfforts: '尚不清楚此模型支持的推理强度。',
  confirmedCreation: '助手创建已确认。', openCreated: '打开助手',
  unknownValue: '未报告', nativeValue: 'Agent 配置',
  sources: { explicit: '明确选择', preference: '成功偏好', local: '本地配置', cloud: '云端配置', native: 'Agent 配置', unknown: '来源未报告' },
};
export const useCreationMessages = () => useI18n().locale === 'zh-CN' ? zh : en;
