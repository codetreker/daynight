import { useId } from 'react';
import { normalizeTagColor } from '../../api/task-tags';
import { useI18n } from '../../i18n/LocaleProvider';
import { TagColorChip } from './TagColor';
import './tag-color-input.css';

export { normalizeTagColor } from '../../api/task-tags';
export const DEFAULT_TAG_COLOR = '#9AA3B2';

const presets = [
  ['Gray', '灰色', DEFAULT_TAG_COLOR], ['Red', '红色', '#D85656'],
  ['Orange', '橙色', '#D47A3D'], ['Yellow', '黄色', '#C8A12E'],
  ['Green', '绿色', '#62A273'], ['Teal', '青色', '#3A9D98'],
  ['Blue', '蓝色', '#4C88C7'], ['Purple', '紫色', '#6B65D8'],
  ['Pink', '粉色', '#C3659A'],
] as const;

export const TagColorInput = ({ value, onChange, disabled = false, attempted = false, name = '' }: {
  readonly value: string; readonly onChange: (value: string) => void; readonly disabled?: boolean;
  readonly attempted?: boolean; readonly name?: string;
}) => {
  const { locale } = useI18n();
  const zh = locale === 'zh-CN';
  const errorId = useId();
  const color = normalizeTagColor(value);
  const invalid = color === null && (attempted || value !== '');
  return <fieldset className="tag-color-input" disabled={disabled}>
    <legend>{zh ? '颜色' : 'Color'}</legend>
    <div className="tag-color-presets">{presets.map(([en, cn, preset]) => <button key={preset} type="button"
      aria-label={`${zh ? cn : en} ${preset}`} aria-pressed={color === preset}
      className="tag-color-preset" style={{ backgroundColor: preset }} onClick={() => onChange(preset)}>
      {color === preset && <span aria-hidden="true">✓</span>}
    </button>)}</div>
    <div className="tag-color-custom">
      <label>{zh ? '自定义颜色' : 'Custom color'}<input type="color" value={color ?? DEFAULT_TAG_COLOR} onChange={event => onChange(event.currentTarget.value.toUpperCase())} /></label>
      <label>{zh ? '十六进制颜色' : 'Hex color'}<input type="text" value={value} aria-invalid={invalid} aria-describedby={invalid ? errorId : undefined} onChange={event => onChange(event.currentTarget.value)} /></label>
    </div>
    {invalid && <p id={errorId} role="alert">{zh ? '请输入 #RRGGBB 格式的颜色。' : 'Enter a color in #RRGGBB format.'}</p>}
    {color !== null && <div className="tag-color-preview">{zh ? '预览' : 'Preview'}: <TagColorChip name={name || (zh ? '标签' : 'Tag')} item={{ id: '', state: 'found', version: 0n, color }} /></div>}
  </fieldset>;
};
