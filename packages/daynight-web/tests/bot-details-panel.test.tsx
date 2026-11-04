import { useRef, useState } from 'react';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { BotDetailsPanel } from '../src/features/bots/BotDetailsPanel';
import { renderWithLocale } from './helpers/renderWithLocale';
import { botDefinition, botWorkerDefaults } from './helpers/bots';

function Harness() {
  const opener = useRef<HTMLButtonElement>(null), [open, setOpen] = useState(false);
  return <><button ref={opener} onClick={() => setOpen(true)}>Assistant</button>{open && <BotDetailsPanel id="details" bot={botDefinition()} worker={botWorkerDefaults()} stale={false} opener={opener} onClose={() => setOpen(false)} />}</>;
}
it('keeps keyboard focus in the narrow drawer and closes only its own layer', () => {
  vi.stubGlobal('innerWidth',390);
  renderWithLocale(<Harness />,{locale:'en'});
  fireEvent.click(screen.getByRole('button',{name:'Assistant'}));
  const dialog = screen.getByRole('dialog',{name:'Assistant details'}), close = within(dialog).getByRole('button',{name:'Close assistant details'});
  expect(close).toHaveFocus();
  expect(fireEvent.keyDown(close,{key:'Tab'})).toBe(false);
  expect(close).toHaveFocus();
  expect(fireEvent.keyDown(close,{key:'Tab',shiftKey:true})).toBe(false);
  fireEvent.keyDown(close,{key:'Escape'});
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('button',{name:'Assistant'})).toHaveFocus();
  expect(document.body.style.overflow).not.toBe('hidden');
});
it('changes responsive modality in place and releases the body lock on cancel',()=>{
  vi.stubGlobal('innerWidth',1440);
  renderWithLocale(<Harness />,{locale:'en'});
  fireEvent.click(screen.getByRole('button',{name:'Assistant'}));
  const panel=screen.getByRole('complementary',{name:'Assistant details'});
  act(()=>{vi.stubGlobal('innerWidth',390);window.dispatchEvent(new Event('resize'));});
  expect(screen.getByRole('dialog',{name:'Assistant details'})).toBe(panel);
  expect(panel).toHaveAttribute('aria-modal','true');
  act(()=>{vi.stubGlobal('innerWidth',1440);window.dispatchEvent(new Event('resize'));});
  expect(screen.getByRole('complementary',{name:'Assistant details'})).toBe(panel);
  expect(panel).not.toHaveAttribute('aria-modal');
  fireEvent(panel,new Event('cancel',{bubbles:false,cancelable:true}));
  expect(screen.queryByRole('complementary')).toBeNull();
  expect(document.body.style.overflow).not.toBe('hidden');
});
