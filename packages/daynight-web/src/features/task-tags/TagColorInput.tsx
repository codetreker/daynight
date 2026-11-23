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
  ['Charcoal', '炭灰色', '#424B57'], ['Slate', '石板灰', '#647995'],
  ['Silver', '银灰色', '#BCC6D4'], ['Brick', '砖红色', '#A43E36'],
  ['Burgundy', '酒红色', '#7C2948'], ['Coral', '珊瑚色', '#F08374'],
  ['Peach', '蜜桃色', '#F3B698'], ['Amber', '琥珀色', '#E89117'],
  ['Lemon', '柠檬黄', '#F1D960'], ['Ochre', '赭黄色', '#987021'],
  ['Olive', '橄榄色', '#788537'], ['Lime', '青柠色', '#9CCB4B'],
  ['Forest', '森林绿', '#2F6E44'], ['Mint', '薄荷绿', '#9AD8B9'],
  ['Emerald', '祖母绿', '#238568'], ['Turquoise', '松石色', '#53C4C1'],
  ['Cyan', '湖蓝色', '#278EAC'], ['Sky', '天蓝色', '#91C5EE'],
  ['Navy', '藏蓝色', '#294B82'], ['Indigo', '靛蓝色', '#424AAB'],
  ['Lavender', '薰衣草色', '#B5A4E8'], ['Plum', '梅紫色', '#864C94'],
  ['Magenta', '洋红色', '#AF377D'],
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
