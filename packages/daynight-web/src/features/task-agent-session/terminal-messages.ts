import { useI18n } from '../../i18n/LocaleProvider';

const en = {
  recording: 'Session recording', screen: 'Terminal screen', partial: 'Partial recording', complete: 'Recorded history',
  play: 'Play', pause: 'Pause', previous: 'Previous frame', next: 'Next frame', timeline: 'Recording time',
  continue: 'Continue to next recorded section', noFollowing: 'No later recorded frames.', zoom: 'Text size',
  gap: 'No recorded screen in this interval.', restart: 'Recording restarted', read_interrupted: 'Recording interrupted',
  recording_limit: 'Recording limit reached', checkpoint_lost: 'Recording checkpoint missing',
  captured: 'Captured', gapLegend: 'Striped areas mark recording gaps.',
};
type TerminalMessages = { readonly [K in keyof typeof en]: string };
const zh: TerminalMessages = {
  recording: 'Session 录制', screen: '终端画面', partial: '部分录制', complete: '录制历史',
  play: '播放', pause: '暂停', previous: '上一帧', next: '下一帧', timeline: '录制时间',
  continue: '继续到下一段录制', noFollowing: '后面没有已录制画面。', zoom: '文字大小',
  gap: '此区间没有已录制画面。', restart: '录制重新开始', read_interrupted: '录制中断',
  recording_limit: '已达录制上限', checkpoint_lost: '录制检查点缺失',
  captured: '采集时间', gapLegend: '条纹区域表示录制缺口。',
};
export const useTerminalMessages = (): TerminalMessages => useI18n().locale === 'zh-CN' ? zh : en;
