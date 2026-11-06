import { Fragment } from 'react';
import type { TerminalFrame } from '../../../../daynight/src/session/v2/types';
import { useTerminalMessages } from './terminal-messages';
import './terminal-session.css';

/** Frames are validated before admission; terminal text never becomes markup. */
export function TerminalText({ frame }: { readonly frame: TerminalFrame }) {
  const m = useTerminalMessages();
  return <div className="terminal-screen" tabIndex={0} role="region" aria-label={m.screen}>
    <pre className="terminal-text" style={{ minWidth: `${frame.width}ch`, minHeight: `${frame.height * 1.75}em` }}>{frame.rows.map((row, rowIndex) => <Fragment key={rowIndex}>
      {row.map((run, runIndex) => <span key={runIndex} style={{
        color: run.inverse ? run.background ?? '#fbfcff' : run.foreground ?? undefined,
        backgroundColor: run.inverse ? run.foreground ?? '#34445c' : run.background ?? undefined,
        fontWeight: run.bold ? 700 : undefined, fontStyle: run.italic ? 'italic' : undefined,
        textDecoration: run.underline ? 'underline' : undefined,
      }}>{run.text}</span>)}{rowIndex < frame.rows.length - 1 ? '\n' : ''}
    </Fragment>)}</pre>
  </div>;
}
