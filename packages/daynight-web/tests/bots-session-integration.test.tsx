vi.mock('../src/api/assistant-tasks', async original => ({ ...await original<typeof import('../src/api/assistant-tasks')>(), listAssistantTasks: async () => ({items:[],nextCursor:null,observedAt:'2026-11-13T00:00:00Z'}) }));
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import * as sessions from '../src/api/sessions';
import { pauseAuthRequests } from '../src/api/client';
import { BotsPage } from '../src/features/bots/BotsPage';
import { createTaskCacheScope, TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { renderWithLocale } from './helpers/renderWithLocale';
import { botBinding, botFixture, botOwner } from './helpers/bot-session';
import { botDefaults, botDefinition, botResponse } from './helpers/bots';
import { assistantDetailsOpener, mockWideAssistantWorkspace, pressAssistantEscape } from './helpers/assistant-ui';

beforeEach(mockWideAssistantWorkspace);

function pageFixture() {
 const fixtures = [botFixture(botBinding(1)), botFixture(botBinding(2))];
 const definitions = fixtures.map((fixture, index) => ({ ...botDefinition(index + 1),
  id: fixture.binding.botId, ownerUserId: botOwner, sessionId: fixture.binding.sessionId,
  testExecutionId: fixture.binding.testExecutionId, startupResult: { state: 'ready', code: null },
  roleConfiguration: { instructions: 'role', revision: 'v1', digest: 'a'.repeat(64) },
  resolvedConfiguration: { ...botDefinition(index + 1).resolvedConfiguration, cwd: `/private/assistant-${index + 1}` },
 }));
 vi.spyOn(sessions, 'createBotSessionApi').mockImplementation(binding => fixtures.find(f => f.binding.botId === binding.botId)!.api);
 const pending = Promise.withResolvers<Response>();
 const fetch = vi.fn(async (url: string | URL | Request, _options?: RequestInit) => {
  const path = String(url);
  if (path.endsWith(definitions[1]!.id)) return pending.promise;
  return botResponse(path.includes('/defaults') ? botDefaults() : path.includes('?') ? { items: definitions, nextCursor: null } : definitions[0], botOwner);
 });
 vi.stubGlobal('fetch', fetch);
 const scope = createTaskCacheScope({ userId: botOwner, onIdentityMismatch: vi.fn() });
 const node = (id: string, enabled = true) => <TaskCacheProvider scope={scope}><BotsPage botId={id} readEnabled={enabled} /></TaskCacheProvider>;
 const view = renderWithLocale(node(definitions[0]!.id), { locale: 'en' });
 return { fixtures, definitions, pending, fetch, scope, node, view, dispose: () => { view.unmount(); scope.dispose(); } };
}

it('keeps details, confirmation and fullscreen in one focus boundary across drawer transitions', async () => {
 const f = pageFixture();
 try {
  const input = await screen.findByRole('textbox', { name: 'Message' });
  await waitFor(() => expect(input).toBeEnabled());
  await waitFor(() => expect(input).not.toHaveAttribute('readonly'));
  fireEvent.change(input, { target: { value: 'Draft survives every focus layer' } });
  const session = input.closest('.task-agent-session'), timeline = f.view.container.querySelector('.session-timeline');
  const boundary = f.view.container.querySelector('.bot-conversation')!;
  const fullscreen = screen.getByRole('button', { name: 'Enter Session fullscreen' });
  fireEvent.click(fullscreen);
  const opener = assistantDetailsOpener('Assistant 1');
  fireEvent.click(opener);
  const details = screen.getByRole('complementary', { name: 'Assistant details' });
  const close = within(details).getByRole('button', { name: 'Close assistant details' });
  expect(boundary).toContainElement(details);
  expect(opener).toHaveAttribute('aria-controls', details.id);
  expect(close).toHaveFocus();
  input.focus();
  pressAssistantEscape(input);
  expect(screen.queryByRole('complementary', { name: 'Assistant details' })).toBeNull();
  expect(boundary).toHaveAttribute('data-session-fullscreen', 'true');
  expect(opener).toHaveFocus();

  fireEvent.click(opener);
  const retainedDetails = screen.getByRole('complementary', { name: 'Assistant details' });
  vi.stubGlobal('innerWidth', 390); fireEvent(window, new Event('resize'));
  expect(screen.getByRole('dialog', { name: 'Assistant details' })).toBe(retainedDetails);
  expect(retainedDetails).toHaveAttribute('aria-modal', 'true');
  const drawerClose = within(retainedDetails).getByRole('button', { name: 'Close assistant details' });
  const remove = within(retainedDetails).getByRole('button', { name: 'Delete assistant' });
  remove.focus(); fireEvent.keyDown(remove, { key: 'Tab' }); expect(drawerClose).toHaveFocus();
  fireEvent.keyDown(drawerClose, { key: 'Tab', shiftKey: true }); expect(remove).toHaveFocus();
  fireEvent.click(remove);
  const confirmation = screen.getByRole('dialog', { name: 'Delete Assistant 1?' });
  expect(boundary).toContainElement(confirmation);
  expect(within(confirmation).getByRole('button', { name: 'Cancel' })).toHaveFocus();
  vi.stubGlobal('innerWidth', 1440); fireEvent(window, new Event('resize'));
  expect(screen.getByRole('dialog', { name: 'Delete Assistant 1?' })).toBe(confirmation);
  pressAssistantEscape(within(confirmation).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog', { name: 'Delete Assistant 1?' })).toBeNull();
  expect(screen.getByRole('complementary', { name: 'Assistant details' })).toBe(retainedDetails);
  expect(remove).toHaveFocus();
  expect(boundary).toHaveAttribute('data-session-fullscreen', 'true');
  pressAssistantEscape(remove);
  expect(opener).toHaveFocus();
  expect(document.body.style.overflow).toBe('hidden');
  pressAssistantEscape(opener);
  expect(boundary).not.toHaveAttribute('data-session-fullscreen');
  expect(fullscreen).toHaveFocus();
  expect(document.body.style.overflow).toBe('');
  expect(screen.getByRole('textbox', { name: 'Message' })).toBe(input);
  expect(input).toHaveValue('Draft survives every focus layer');
  expect(input.closest('.task-agent-session')).toBe(session);
  expect(f.view.container.querySelector('.session-timeline')).toBe(timeline);
  expect(f.fixtures[0]!.api.current).toHaveBeenCalledOnce();
  expect(f.fixtures[0]!.api.channel).toHaveBeenCalledOnce();
  expect(f.fixtures[0]!.api.command).not.toHaveBeenCalled();
  expect(f.fetch.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
 } finally { f.dispose(); }
});

it.each([200, 403, 404, 410])('never shows the previous private target while a selected assistant read resolves with %s', async status => {
 const f = pageFixture();
 try {
  const input = await screen.findByRole('textbox', { name: 'Message' });
  await waitFor(() => expect(input).toBeEnabled());
  await waitFor(() => expect(input).not.toHaveAttribute('readonly'));
  fireEvent.change(input, { target: { value: 'Private draft A' } });
  fireEvent.click(assistantDetailsOpener('Assistant 1'));
  const details = screen.getByRole('complementary', { name: 'Assistant details' });
  expect(details).toHaveTextContent('/private/assistant-1');
  f.view.rerender(f.node(f.definitions[1]!.id));
  expect(screen.getByRole('complementary', { name: 'Assistant details' })).toBe(details);
  expect(details).not.toHaveTextContent('/private/assistant-1');
  expect(details).not.toHaveTextContent('Assistant 1');
  expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  expect(input.closest('.bot-session-pane')).toHaveAttribute('hidden');
  expect(input.closest('.bot-session-pane')).toHaveAttribute('inert');
  expect(assistantDetailsOpener('Assistant 2')).toBeDisabled();
  expect(f.fixtures[1]!.api.current).not.toHaveBeenCalled();
  await act(async () => f.pending.resolve(status === 200 ? botResponse(f.definitions[1], botOwner) : new Response(JSON.stringify({ error: { code: 'not_found', message: 'Unavailable', requestId: 'denied-target' } }), { status, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': botOwner } })));
  if (status === 200) {
   await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled());
   expect(details).toHaveTextContent('/private/assistant-2');
   expect(details).not.toHaveTextContent('/private/assistant-1');
   expect(screen.getByRole('textbox', { name: 'Message' })).not.toBe(input);
  } else {
   await screen.findByText('denied-target');
   expect(screen.queryByRole('complementary', { name: 'Assistant details' })).toBeNull();
   expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
   expect(f.fixtures[1]!.api.current).not.toHaveBeenCalled();
   expect(screen.getByRole('link', { name: 'Back to assistants' })).toBeVisible();
   expect(f.view.container.querySelector(`[data-bot-id="${f.fixtures[1]!.binding.botId}"]`)).toBeNull();
  }
  f.view.rerender(f.node(f.definitions[0]!.id));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toBe(input));
  expect(input).toHaveValue('Private draft A');
  const currentOpener = assistantDetailsOpener('Assistant 1');
  if (currentOpener.getAttribute('aria-expanded') !== 'true') fireEvent.click(currentOpener);
  pressAssistantEscape(screen.getByRole('button', { name: 'Close assistant details' }));
  expect(currentOpener).toHaveFocus();
  expect(f.fixtures[0]!.api.channel).toHaveBeenCalledOnce();
  expect(f.fixtures.every(fixture => vi.mocked(fixture.api.command).mock.calls.length === 0)).toBe(true);
 } finally { f.dispose(); }
});

it('keeps real shared Session nodes and drafts across list selection and close/reopen without commands',async()=>{
 const fixtures=[botFixture(botBinding(1)),botFixture(botBinding(2))];
 const definitions=fixtures.map((fixture,n)=>({...botDefinition(n+1),id:fixture.binding.botId,ownerUserId:botOwner,sessionId:fixture.binding.sessionId,testExecutionId:fixture.binding.testExecutionId,roleConfiguration:{instructions:'role',revision:'v1',digest:'a'.repeat(64)},startupResult:{state:'ready',code:null}}));
 vi.spyOn(sessions,'createBotSessionApi').mockImplementation(binding=>fixtures.find(f=>f.binding.botId===binding.botId)!.api);
 const fetch=vi.fn(async(url:string|URL|Request)=>botResponse(String(url).includes('/defaults')?botDefaults():String(url).includes('?')?{items:definitions,nextCursor:null}:definitions.find(d=>String(url).endsWith(d.id)),botOwner));vi.stubGlobal('fetch',fetch);
 const scope=createTaskCacheScope({userId:botOwner,onIdentityMismatch:vi.fn()});
 const node=(id:string|null)=><TaskCacheProvider scope={scope}><BotsPage botId={id} readEnabled /></TaskCacheProvider>;
 const view=renderWithLocale(node(definitions[0]!.id),{locale:'en'});
 try{
  const a=await screen.findByRole('textbox',{name:'Message'});await waitFor(()=>expect(a).toBeEnabled());await waitFor(()=>expect(a).not.toHaveAttribute('readonly'));fireEvent.change(a,{target:{value:'draft A'}});
  const host=view.container.querySelector('.bot-session-host');
  const session=a.closest('.task-agent-session'), channels=vi.mocked(fixtures[0]!.api.channel).mock.calls.length;
  fireEvent.click(assistantDetailsOpener('Assistant 1'));
  expect(screen.getByRole('complementary',{name:'Assistant details'})).toBeVisible();
  fireEvent.keyDown(screen.getByRole('button',{name:'Close assistant details'}),{key:'Escape'});
  expect(screen.getByRole('textbox',{name:'Message'})).toBe(a);
  expect(a.closest('.task-agent-session')).toBe(session);
  expect(vi.mocked(fixtures[0]!.api.channel).mock.calls.length).toBe(channels);
  fireEvent.click(screen.getByRole('button',{name:'Enter Session fullscreen'}));
  expect(view.container.querySelector('.bot-conversation')).toHaveAttribute('data-session-fullscreen','true');
  fireEvent.click(assistantDetailsOpener('Assistant 1'));
  fireEvent.keyDown(screen.getByRole('button',{name:'Close assistant details'}),{key:'Escape'});
  expect(view.container.querySelector('.bot-conversation')).toHaveAttribute('data-session-fullscreen','true');
  fireEvent.keyDown(assistantDetailsOpener('Assistant 1'),{key:'Escape'});
  expect(view.container.querySelector('.bot-conversation')).not.toHaveAttribute('data-session-fullscreen');
  expect(screen.getByRole('textbox',{name:'Message'})).toBe(a);
  view.rerender(node(definitions[1]!.id));await waitFor(()=>expect(screen.getByRole('textbox',{name:'Message'})).not.toBe(a));
  await waitFor(()=>expect(screen.getByRole('textbox',{name:'Message'})).not.toHaveAttribute('readonly'));
  fireEvent.change(screen.getByRole('textbox',{name:'Message'}),{target:{value:'draft B'}});
  view.rerender(node(null));expect(screen.queryByRole('textbox',{name:'Message'})).toBeNull();
  view.rerender(node(definitions[0]!.id));await waitFor(()=>expect(screen.getByRole('textbox',{name:'Message'})).toBe(a));
  expect(a).toHaveValue('draft A');expect(view.container.querySelector('.bot-session-host')).toBe(host);
  expect(fixtures.every(f=>vi.mocked(f.api.command).mock.calls.length===0)).toBe(true);
 }finally{view.unmount();scope.dispose();}
});

it('retains the real session pane, draft and display state while identity and Bot reads recover',async()=>{
 const fixture=botFixture();
 const definition={...botDefinition(),id:fixture.binding.botId,ownerUserId:botOwner,sessionId:fixture.binding.sessionId,testExecutionId:fixture.binding.testExecutionId,roleConfiguration:{instructions:'role',revision:'v1',digest:'a'.repeat(64)},startupResult:{state:'ready',code:null}};
 vi.spyOn(sessions,'createBotSessionApi').mockReturnValue(fixture.api);
 const pending: Array<{url:string; request:ReturnType<typeof Promise.withResolvers<Response>>}> = [];
 let defer=false;
 const fetch=vi.fn(async(url:string|URL|Request, _options?:RequestInit)=>{
  const path=String(url);
  if(defer){const request=Promise.withResolvers<Response>();pending.push({url:path,request});return request.promise;}
  return botResponse(path.includes('/defaults')?botDefaults():path.includes('?')?{items:[definition],nextCursor:null}:definition,botOwner);
 }); vi.stubGlobal('fetch',fetch);
 const scope=createTaskCacheScope({userId:botOwner,onIdentityMismatch:vi.fn()});
 const node=(enabled:boolean)=><TaskCacheProvider scope={scope}><BotsPage botId={definition.id} readEnabled={enabled} /></TaskCacheProvider>;
 const view=renderWithLocale(node(true),{locale:'en'}); let resume: (()=>void)|undefined;
 try{
  const input=await screen.findByRole('textbox',{name:'Message'}); await waitFor(()=>expect(input).toBeEnabled());
  await waitFor(() => expect(input).not.toHaveAttribute('readonly'));
  fireEvent.change(input,{target:{value:'unfinished draft'}});
  fireEvent.click(screen.getByRole('button',{name:'Enter Session fullscreen'}));
  fireEvent.click(screen.getByRole('button',{name:'Display'}));
  const menu=screen.getByRole('menu'), pane=input.closest('.bot-session-pane'), timeline=view.container.querySelector('.session-timeline');
  const channelCount=vi.mocked(fixture.api.channel).mock.calls.length;
  defer=true; resume=pauseAuthRequests(); view.rerender(node(false));
  expect(screen.getByRole('textbox',{name:'Message'})).toBe(input); expect(input).toBeVisible(); expect(input).toHaveValue('unfinished draft');
  expect(screen.getByRole('menu')).toBe(menu); expect(pane).toBeVisible();
  expect(view.container.querySelector('.bot-conversation')).toHaveAttribute('data-session-fullscreen','true');
  await waitFor(()=>expect(screen.getByRole('button',{name:'Send'})).toBeDisabled());
  fireEvent.change(input,{target:{value:'edited after pause'}});
  expect(input).toHaveValue('edited after pause'); expect(screen.getByRole('menu')).toBe(menu);
  expect(view.container.querySelector('.session-timeline')).toBe(timeline);
  expect(vi.mocked(fixture.api.channel)).toHaveBeenCalledTimes(channelCount);
  expect(fixture.api.command).not.toHaveBeenCalled();
  expect(fetch.mock.calls.every(([, options])=>!options?.method || options.method==='GET')).toBe(true);
 }finally{resume?.();view.unmount();scope.dispose();}
});
