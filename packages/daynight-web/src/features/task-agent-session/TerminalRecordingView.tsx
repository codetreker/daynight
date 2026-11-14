import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { SessionV2Archive } from '../../../../daynight/src/session/v2/types';
import { parseTerminalFrame } from '../../../../daynight/src/session/v2/protocol';
import { TerminalText } from './TerminalText';
import { NativeSelect } from '../../ui/native-select/NativeSelect';
import { advanceTerminalPlayback, buildTerminalPlayback, formatTerminalTime, nextTerminalFrame, seekTerminalPlayback } from './terminal-playback';
import { useTerminalMessages } from './terminal-messages';
import './terminal-session.css';

type Props = { readonly archive: SessionV2Archive; readonly active: boolean };
const fraction = (value: bigint, total: bigint) => total === 0n ? 0 : Number(value * 10000n / total);

function Recording({ archive, active }: Props) {
  const m = useTerminalMessages();
  const model = useMemo(() => buildTerminalPlayback(archive), [archive]);
  const gaps = useMemo(() => model.items.filter(item => item.kind === 'gap'), [model]);
  const [cursor, setCursor] = useState({ index: 0, time: model.items[0]!.time, playing: false });
  const [zoom, setZoom] = useState('100');
  const item = model.items[cursor.index]!;
  const frame = useMemo(() => item.kind === 'frame' ? parseTerminalFrame(JSON.parse(item.file.data)) : null, [item]);
  const previous = nextTerminalFrame(model, cursor.index, -1), next = nextTerminalFrame(model, cursor.index, 1);
  useEffect(() => {
    if (!active) setCursor(value => value.playing ? { ...value, playing: false } : value);
  }, [active]);
  useEffect(() => {
    const hide = () => { if (document.visibilityState === 'hidden') setCursor(value => value.playing ? { ...value, playing: false } : value); };
    document.addEventListener('visibilitychange', hide);
    return () => document.removeEventListener('visibilitychange', hide);
  }, []);
  useEffect(() => {
    if (!active || !cursor.playing) return;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now(), elapsed = BigInt(Math.max(0, Math.floor(now - last))); last = now;
      setCursor(value => {
        if (!value.playing) return value;
        const next = advanceTerminalPlayback(model, value.index, value.time + elapsed);
        return { index: next.index, time: next.time, playing: !next.stopped };
      });
    }, 100);
    return () => clearInterval(timer);
  }, [active, cursor.playing, model]);
  const select = (index: number) => setCursor({ index, time: model.items[index]!.time, playing: false });
  const seek = (value: string) => {
    const time = model.duration * BigInt(value) / 10000n;
    const index = seekTerminalPlayback(model, time);
    setCursor({ index, time: model.items[index]!.time > time ? model.items[index]!.time : time, playing: false });
  };
  return <section className="terminal-recording" aria-label={m.recording} style={{ '--terminal-text-scale': Number(zoom) / 100 } as CSSProperties}>
    <div className="terminal-recording-summary"><span className={archive.completeness === 'partial' ? 'terminal-partial' : ''}>{archive.completeness === 'partial' ? m.partial : m.complete}</span>
      <label>{m.zoom}<NativeSelect density="filter" layout="content" value={zoom} onChange={event => setZoom(event.currentTarget.value)}><option value="75">75%</option><option value="100">100%</option><option value="125">125%</option><option value="150">150%</option></NativeSelect></label>
    </div>
    <div className="terminal-recording-display">{frame ? <TerminalText frame={frame} /> : item.kind === 'gap' ? <div className="terminal-recording-gap" role="status"><strong>{m[item.reason]}</strong><p>{m.gap}</p>{next === null ? <p>{m.noFollowing}</p> : <button className="button" type="button" onClick={() => select(next)}>{m.continue}</button>}</div> : null}</div>
    <div className="terminal-recording-controls">
      <div className="terminal-recording-buttons"><button className="button" type="button" disabled={!active || previous === null} onClick={() => select(previous!)}>{m.previous}</button>
        <button className="button" type="button" disabled={!active || item.kind === 'gap' || cursor.time >= model.duration} onClick={() => setCursor(value => ({ ...value, playing: !value.playing }))}>{cursor.playing ? m.pause : m.play}</button>
        <button className="button" type="button" disabled={!active || next === null} onClick={() => select(next!)}>{m.next}</button>
        <output className="terminal-recording-time">{formatTerminalTime(cursor.time)} / {formatTerminalTime(model.duration)}</output>
      </div>
      <input type="range" min="0" max="10000" step="1" value={fraction(cursor.time, model.duration)} aria-label={m.timeline} aria-valuetext={formatTerminalTime(cursor.time)} disabled={!active || model.duration === 0n} onChange={event => seek(event.currentTarget.value)} />
      <div className="terminal-recording-gap-track" aria-hidden="true">{gaps.map((entry, index) => <span key={index} style={{ left: `${fraction(entry.time, model.duration) / 100}%`, width: `${fraction(entry.end - entry.time, model.duration) / 100}%` }} />)}</div>
      <div className="terminal-recording-caption">{frame ? <time dateTime={frame.capturedAt}>{m.captured}: {frame.capturedAt}</time> : <span>{formatTerminalTime(item.time)}{item.kind === 'gap' && item.end > item.time ? ` – ${formatTerminalTime(item.end)}` : ''}</span>}{archive.completeness === 'partial' ? <span>{m.gapLegend}</span> : null}</div>
    </div>
  </section>;
}

export const TerminalRecordingView = (props: Props) => <Recording key={`${props.archive.sessionId}/${props.archive.finalizationId}`} {...props} />;
