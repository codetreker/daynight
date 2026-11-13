vi.mock('../src/api/assistant-tasks', async original => ({ ...await original<typeof import('../src/api/assistant-tasks')>(), listAssistantTasks: async () => ({items:[],nextCursor:null,observedAt:'2026-11-13T00:00:00Z'}) }));
import type { SessionHeaderSlot, SessionPresentationSlots } from '../src/features/task-agent-session/session-presentation-slots';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BotsPage } from '../src/features/bots/BotsPage';
import { createTaskCacheScope, TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { renderWithLocale } from './helpers/renderWithLocale';
import { BOT_USER, botDefinition, botDefaults, botId, botResponse, botError } from './helpers/bots';
import { parseAuthRoute } from '../src/app/router';
import * as router from '../src/app/router';
import { pauseAuthRequests } from '../src/api/client';
import { assistantCreateSubmit, assistantDetailsOpener, expandAssistantAdvancedSettings, mockWideAssistantWorkspace, openAssistantCreation } from './helpers/assistant-ui';
vi.mock('../src/features/bots/BotSessionHost', () => ({ useBotSessionCache: () => cache, BotSessionHost: ({ displayBinding, presentation, error, active }: {displayBinding: {botId:string}|null; presentation: SessionPresentationSlots; error?: string | null; active: boolean}) => <section data-testid="host"><header>{presentation.renderHeader?.(undefined as unknown as SessionHeaderSlot)}</header>{displayBinding?.botId ?? 'no binding'}{active && error ? presentation.renderUnavailable?.({ phase: 'binding', hasContent: false, retry: () => {}, error }) : null}</section> }));
const emptyPanes = Object.freeze([]);
const cache = { snapshot: () => emptyPanes, suspendActions: vi.fn(), invalidateBot: vi.fn(), blockBot: vi.fn(), unblockBot: vi.fn(), isBlocked: () => false, isRevoked: () => false, subscribe: () => () => {}, guardSnapshot: () => 0 };
const scopes: ReturnType<typeof createTaskCacheScope>[] = [];
beforeEach(mockWideAssistantWorkspace);
afterEach(() => scopes.splice(0).forEach(scope => scope.dispose()));
function mount(bot: string|null = null) {
 const scope = createTaskCacheScope({userId: BOT_USER, onIdentityMismatch:vi.fn()}); scopes.push(scope);
 const node = (id: string|null, enabled = true) => <TaskCacheProvider scope={scope}><BotsPage botId={id} readEnabled={enabled} /></TaskCacheProvider>;
 const result = renderWithLocale(node(bot), {locale:'en'}); return {...result, select:(id:string|null, enabled = true)=>result.rerender(node(id, enabled)), scope};
}
function fixture() {
 const bots = [botDefinition(1),botDefinition(2)];
 const fetch = vi.fn(async (url: string|URL|Request, _options?: RequestInit) => {
  const path = String(url);
  if(path.includes('/defaults')) return botResponse(botDefaults());
  if(path.includes('?')) return botResponse({items:bots,nextCursor:null});
  return botResponse(bots.find(bot=>path.endsWith(bot.id))!);
 }); vi.stubGlobal('fetch',fetch); return {bots,fetch};
}
it('registers guarded direct Bot routes without accepting malformed IDs',()=>{
 expect(parseAuthRoute('/bots')).toEqual({kind:'bots'});
 expect(parseAuthRoute(`/bots/${botId()}`)).toEqual({kind:'bot',botId:botId()});
 expect(parseAuthRoute('/bots/not-an-id')).toEqual({kind:'notFound'});
});
it('opens details from the name, follows selection and returns focus without replacing the session host',async()=>{
 const f=fixture(); f.bots[1]!.resolvedConfiguration.cwd='/second/directory';
 const view=mount(botId(1)); await screen.findByRole('heading',{name:'Assistant 1'}); const opener=assistantDetailsOpener('Assistant 1');
 const host=screen.getByTestId('host'); expect(screen.queryByRole('complementary',{name:'Assistant details'})).toBeNull();
 fireEvent.click(opener);
 const panel=screen.getByRole('complementary',{name:'Assistant details'});
 expect(within(panel).getByText('/ordinary/directory')).toBeVisible();
 expect(within(panel).getByText('Machine 20')).toBeVisible();
 expect(within(panel).queryByRole('switch')).toBeNull();
 view.select(botId(2)); await screen.findByRole('heading',{name:'Assistant 2'});
 expect(within(panel).getByText('/second/directory')).toBeVisible();
 expect(within(panel).queryByText('Assistant 1')).toBeNull();
 fireEvent.keyDown(within(panel).getByRole('button',{name:'Close assistant details'}),{key:'Escape'});
 expect(screen.queryByRole('complementary',{name:'Assistant details'})).toBeNull();
 expect(assistantDetailsOpener('Assistant 2')).toHaveFocus();
 expect(screen.getByTestId('host')).toBe(host);
});
it('loads every page for search and keeps the selected shell stable when closing and reopening',async()=>{
 const f=fixture(); const second=botDefinition(2);
 f.fetch.mockImplementation(async url=>String(url).includes('/defaults')?botResponse(botDefaults()):String(url).includes('cursor=next')?botResponse({items:[second],nextCursor:null}):String(url).includes('?')?botResponse({items:[f.bots[0]],nextCursor:'next'}):botResponse(f.bots.find(b=>String(url).endsWith(b.id))));
 const view=mount(); await screen.findByRole('link',{name:/Assistant 2/});
 fireEvent.change(screen.getByRole('searchbox'),{target:{value:'2'}});
 expect(screen.queryByRole('link',{name:/Assistant 1/})).toBeNull();
 const shell=screen.getByTestId('host'); view.select(botId(2)); await screen.findByRole('heading',{name:'Assistant 2'});
 view.select(null); expect(screen.getByTestId('host')).toBe(shell); view.select(botId(2)); await screen.findByRole('heading',{name:'Assistant 2'});
 expect(screen.getByTestId('host')).toBe(shell); expect(f.fetch.mock.calls.every(([, options])=>!options || (options as RequestInit).method!=='DELETE')).toBe(true);
});
it('fences late selected reads and invalidates access loss without showing old content',async()=>{
 const f=fixture(); let resolve!:(r:Response)=>void;
 f.fetch.mockImplementation(async url=>String(url).includes('/defaults')?botResponse(botDefaults()):String(url).includes('?')?botResponse({items:f.bots,nextCursor:null}):String(url).endsWith(botId(1))?await new Promise(r=>resolve=r):botError(404,'not_found'));
 const view=mount(botId(1)); await waitFor(()=>expect(resolve).toBeDefined()); view.select(botId(2));
 await screen.findByRole('alert'); await act(async()=>resolve(botResponse(f.bots[0])));
 expect(screen.queryByRole('heading',{name:'Assistant 1'})).toBeNull(); expect(cache.invalidateBot).toHaveBeenCalledWith(botId(2));
});
it('clears open details while the next selection loads and dismisses them on access loss',async()=>{
 const f=fixture(); const view=mount(botId(1));
 await screen.findByRole('heading',{name:'Assistant 1'}); fireEvent.click(assistantDetailsOpener('Assistant 1'));
 let resolve!:(r:Response)=>void;
 f.fetch.mockImplementation(async url=>String(url).includes('/defaults')?botResponse(botDefaults()):String(url).includes('?')?botResponse({items:f.bots,nextCursor:null}):await new Promise(r=>resolve=r));
 view.select(botId(2));
 const panel=screen.getByRole('complementary',{name:'Assistant details'});
 expect(within(panel).queryByText('/ordinary/directory')).toBeNull();
 expect(within(panel).queryByText('Assistant 1')).toBeNull();
 expect(screen.getByTestId('host')).toHaveTextContent('no binding');
 await waitFor(()=>expect(resolve).toBeDefined()); await act(async()=>resolve(botError(403,'forbidden')));
 expect(screen.queryByRole('complementary',{name:'Assistant details'})).toBeNull();
 expect(cache.invalidateBot).toHaveBeenCalledWith(botId(2));
});
it('shows pending, startup failure and offline observations without inventing ready status',async()=>{
 const f=fixture(); f.bots[1]!.startupResult={state:'failed',code:'invalid_cwd'};
 const defaults=botDefaults(); (defaults.workers[0] as unknown as {state:string}).state='offline';
 f.fetch.mockImplementation(async url=>String(url).includes('/defaults')?botResponse(defaults):String(url).includes('?')?botResponse({items:f.bots,nextCursor:null}):botResponse(f.bots[1]));
 mount(botId(2)); await screen.findByRole('heading',{name:'Assistant 2'}); expect(screen.getAllByText(/invalid_cwd|directory/i).length).toBeGreaterThan(0);
 expect(screen.queryByText('Ready')).toBeNull();
});
it('preserves a read failure instead of treating it as an empty list and retries',async()=>{
 const f=fixture(); f.fetch.mockRejectedValueOnce(new TypeError('network'));
 mount(); await screen.findByRole('alert'); fireEvent.click(screen.getAllByRole('button',{name:'Retry'})[0]!);
 await screen.findByRole('link',{name:/Assistant 1/});
});
it('keeps an unknown creation across leaving and reopening the page and only queries that ID',async()=>{
 const f=fixture();let submitted='';let creates=0;
 f.fetch.mockImplementation(async (url,options)=>{
  if(options?.method==='POST'){submitted=JSON.parse(String(options.body)).id;creates++;throw TypeError('response lost');}
  if(String(url).includes('/defaults'))return botResponse(botDefaults());
  if(String(url).includes('?'))return botResponse({items:[],nextCursor:null});
  return botError(404,'not_found');
 });
 const view=mount();openAssistantCreation();
 await waitFor(()=>expect(screen.getByLabelText('Name')).toBeEnabled());
 fireEvent.change(screen.getByLabelText('Name'),{target:{value:'Unknown'}});
 await waitFor(()=>expect(assistantCreateSubmit()).toBeEnabled());
 fireEvent.click(assistantCreateSubmit());
 await screen.findByRole('button',{name:'Check creation'});await waitFor(()=>expect(screen.getByRole('button',{name:'Check creation'})).toBeEnabled());
 view.unmount();
 const restored=renderWithLocale(<TaskCacheProvider scope={view.scope}><BotsPage botId={null} readEnabled /></TaskCacheProvider>,{locale:'en'});
 openAssistantCreation();expect(screen.queryByLabelText('Name')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Check creation'}));await screen.findByRole('alert');
 expect(creates).toBe(1);expect(f.fetch.mock.calls.some(([url])=>String(url).endsWith(submitted))).toBe(true);restored.unmount();
});

it('opens the row menu by keyboard and cancels deletion without changing the current conversation', async () => {
 const f=fixture(); mount(botId(1));
 const menu=await screen.findByRole('button',{name:'More actions for Assistant 2'});
 menu.focus(); fireEvent.keyDown(menu,{key:'ArrowDown'});
 fireEvent.click(screen.getByRole('menuitem',{name:'Delete assistant'}));
 const dialog=screen.getByRole('dialog',{name:'Delete Assistant 2?'});
 fireEvent.click(within(dialog).getByRole('button',{name:'Cancel'}));
 expect(menu).toHaveFocus(); expect(screen.getByRole('heading',{name:'Assistant 1'})).toBeVisible();
 expect(f.fetch.mock.calls.some(([,o])=>o?.method==='DELETE')).toBe(false);
});
it('keeps the creation form and its local selections mounted throughout an admission pause and recovery reads', async () => {
 const f=fixture(), view=mount();
 await screen.findByRole('link',{name:/Assistant 1/});
 openAssistantCreation();
 const name=await screen.findByLabelText('Name');
 await waitFor(()=>expect(assistantCreateSubmit()).toBeEnabled());
 fireEvent.change(name,{target:{value:'My assistant'}});
 expandAssistantAdvancedSettings();
 const cwd=screen.getByLabelText('Working directory'), agent=screen.getByLabelText('Agent');
 fireEvent.change(cwd,{target:{value:'/custom/place'}});
 fireEvent.change(agent,{target:{value:'claude'}});
 name.focus(); (name as HTMLInputElement).setSelectionRange(2, 5);
 const pending: Array<{url:string; request:ReturnType<typeof Promise.withResolvers<Response>>}> = [];
 f.fetch.mockImplementation(async url=>{ const request=Promise.withResolvers<Response>(); pending.push({url:String(url),request}); return request.promise; });
 view.select(null,false);
 expect(screen.getByLabelText('Name')).toBeVisible();
 expect(screen.getByLabelText('Name')).toBe(name); expect(name).toHaveFocus();
 expect((name as HTMLInputElement).selectionStart).toBe(2); expect((name as HTMLInputElement).selectionEnd).toBe(5);
 expect(cwd).toHaveValue('/custom/place'); expect(agent).toHaveValue('claude');
 expect(screen.getByRole('textbox',{name:'Working directory'})).toBeVisible();
 expect(screen.getByRole('combobox',{name:'Agent'})).toBeVisible();
 fireEvent.click(assistantCreateSubmit());
 expect(f.fetch.mock.calls.some(([, options])=>options?.method==='POST')).toBe(false);
 view.select(null,true);
 await waitFor(()=>expect(pending.length).toBeGreaterThanOrEqual(2));
 expect(screen.getByLabelText('Name')).toBe(name); expect(name).toHaveValue('My assistant'); expect(cwd).toHaveValue('/custom/place');
 await act(async()=>{for(const {url,request} of pending) request.resolve(botResponse(url.includes('/defaults')?botDefaults():{items:f.bots,nextCursor:null}));});
 expect(screen.getByLabelText('Name')).toBe(name); expect(name).toHaveValue('My assistant');
 expect(f.fetch.mock.calls.every(([url, options])=>!options?.method || options.method==='GET' || String(url).endsWith('/readonly/requests'))).toBe(true);
});
it('retains the open details and delete confirmation when admission pauses', async () => {
 const f=fixture(), view=mount(botId(1));
 await screen.findByRole('heading',{name:'Assistant 1'}); fireEvent.click(assistantDetailsOpener('Assistant 1'));
 const panel=screen.getByRole('complementary',{name:'Assistant details'}), close=within(panel).getByRole('button',{name:'Close assistant details'});
 expect(close).toHaveFocus(); view.select(botId(1),false);
 expect(screen.getByRole('complementary',{name:'Assistant details'})).toBe(panel); expect(close).toHaveFocus();
 view.select(botId(1),true); await waitFor(()=>expect(assistantDetailsOpener('Assistant 1')).toBeEnabled());
 expect(screen.getByRole('complementary',{name:'Assistant details'})).toBe(panel);
 fireEvent.click(close);
 fireEvent.click(screen.getByRole('button',{name:'More actions for Assistant 2'}));
 fireEvent.click(screen.getByRole('menuitem',{name:'Delete assistant'}));
 const dialog=screen.getByRole('dialog',{name:'Delete Assistant 2?'}), cancel=within(dialog).getByRole('button',{name:'Cancel'});
 expect(cancel).toHaveFocus(); view.select(botId(1),false);
 expect(screen.getByRole('dialog',{name:'Delete Assistant 2?'})).toBe(dialog); expect(cancel).toHaveFocus();
 fireEvent.click(within(dialog).getByRole('button',{name:'Delete assistant'}));
 expect(screen.getByRole('dialog',{name:'Delete Assistant 2?'})).toBe(dialog);
 expect(f.fetch.mock.calls.some(([, options])=>options?.method==='DELETE')).toBe(false);
 view.select(botId(1),true); expect(screen.getByRole('dialog',{name:'Delete Assistant 2?'})).toBe(dialog);
 expect(f.fetch.mock.calls.some(([, options])=>options?.method==='DELETE')).toBe(false);
});
it('cannot navigate from a late creation response after selecting another Bot during an identity pause',async()=>{
 const f=fixture(), response=Promise.withResolvers<Response>(), navigate=vi.spyOn(router,'navigate');
 f.fetch.mockImplementation(async(url,options)=>options?.method==='POST'?response.promise:String(url).includes('/defaults')?botResponse(botDefaults()):String(url).includes('?')?botResponse({items:f.bots,nextCursor:null}):botResponse(f.bots.find(bot=>String(url).endsWith(bot.id))));
 const view=mount(); let resume: (()=>void)|undefined;
 try{
  await screen.findByRole('link',{name:/Assistant 1/}); openAssistantCreation();
  fireEvent.change(screen.getByRole('textbox',{name:'Name'}),{target:{value:'Late'}});
  await waitFor(()=>expect(assistantCreateSubmit()).toBeEnabled());
  fireEvent.click(assistantCreateSubmit());
  await waitFor(()=>expect(f.fetch.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(1));
  const pendingCreation=screen.getByRole('button',{name:'Creating…'});
  resume=pauseAuthRequests(); view.select(botId(2),false); expect(pendingCreation).not.toBeVisible();
  await act(async()=>response.resolve(botResponse(f.bots[0]))); resume(); resume=undefined;
  view.select(botId(2),true); await screen.findByRole('heading',{name:'Assistant 2'});
  expect(navigate).not.toHaveBeenCalled(); expect(f.fetch.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(1);
 }finally{resume?.();navigate.mockRestore();}
});
it('deletes the context-menu target and keeps pending cleanup distinct from completion', async () => {
 const f=fixture(); let submitted: {url:string;body:unknown}|null=null;
 f.fetch.mockImplementation(async(url,options)=>{
  if(options?.method==='DELETE') { submitted={url:String(url),body:JSON.parse(String(options.body))}; const body=submitted.body as {deletionId:string;ifVersion:string}; return botResponse({id:botId(2),workerId:botId(20),version:'2',deletion:{deletionId:body.deletionId,requestedVersion:body.ifVersion,workerCleanup:{state:'pending',code:null},serverCleanup:{state:'pending',code:null}}}); }
  return String(url).includes('/defaults')?botResponse(botDefaults()):String(url).includes('?')?botResponse({items:f.bots,nextCursor:null}):botResponse(f.bots[0]);
 });
 mount(botId(1)); const row=await screen.findByRole('link',{name:/Assistant 2/}); fireEvent.contextMenu(row);
 fireEvent.click(screen.getByRole('menuitem',{name:'Delete assistant'}));
 fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Delete assistant'}));
 await screen.findByText('Waiting for cleanup');
 expect((submitted as {url:string}|null)?.url).toBe(`/api/v1/me/bots/${botId(2)}`);
 expect(screen.queryByRole('link',{name:/Assistant 2/})).toBeNull();
 expect(screen.getByRole('heading',{name:'Assistant 1'})).toBeVisible();
 expect(screen.queryByText('Deletion completed')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Refresh'})).toBeEnabled());
 expect(screen.queryByRole('link',{name:/Assistant 2/})).toBeNull();
});
it('keeps sending blocked after an unknown delete even when a following read still returns active',async()=>{
 const f=fixture(); f.fetch.mockImplementation(async(url,options)=>{
  if(options?.method==='DELETE') throw new TypeError('response lost');
  return String(url).includes('/defaults')?botResponse(botDefaults()):String(url).includes('?')?botResponse({items:f.bots,nextCursor:null}):botResponse(f.bots[0]);
 });
 mount(botId(1)); fireEvent.click(await screen.findByRole('button',{name:'More actions for Assistant 1'}));
 fireEvent.click(screen.getByRole('menuitem',{name:'Delete assistant'}));
 fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Delete assistant'}));
 await screen.findByText('Deletion result unknown');
 expect(screen.getByTestId('host')).toHaveTextContent('no binding');
 expect(f.fetch.mock.calls.filter(([,o])=>o?.method==='DELETE')).toHaveLength(1);
});

it.each([0, 1])('clears report attention on opening while preserving %s pending proposals', async pendingProposals => {
 const f=fixture(); f.bots[0]!.attentionCount=2+pendingProposals;
 const base=f.fetch.getMockImplementation()!;
 f.fetch.mockImplementation(async (url,options)=>{
  if(String(url).endsWith('/attention/seen')) { f.bots[0]!.attentionCount=pendingProposals; return botResponse({targetBotId:botId()}); }
  return base(url,options);
 });
 const view=mount(); await screen.findByLabelText(`${2+pendingProposals} items need your attention`);
 expect(f.fetch.mock.calls.some(([,o])=>o?.method==='POST')).toBe(false);
 view.select(botId());
 await waitFor(()=>expect(screen.queryByLabelText(`${2+pendingProposals} items need your attention`)).toBeNull());
 if(pendingProposals) expect(screen.getByLabelText('1 items need your attention')).toHaveTextContent('1');
 else expect(document.querySelector('.bot-attention-count')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Refresh'})).not.toHaveAttribute('aria-busy','true'));
 expect(f.fetch.mock.calls.filter(([,o])=>o?.method==='POST')).toHaveLength(1);
});

it('keeps attention visible after a failed seen request and refreshes without replay', async()=>{
 const f=fixture(); f.bots[0]!.attentionCount=2;
 const base=f.fetch.getMockImplementation()!;
 f.fetch.mockImplementation(async (url,options)=>String(url).endsWith('/attention/seen')?botError(500,'internal_error'):base(url,options));
 mount(botId());
 await screen.findByText('Could not confirm that these items were seen.');
 expect(screen.getByLabelText('2 items need your attention')).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'Retry'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Refresh'})).not.toHaveAttribute('aria-busy','true'));
 expect(f.fetch.mock.calls.filter(([,o])=>o?.method==='POST')).toHaveLength(1);
});

it('does not mark hidden or admission-paused conversations seen and fences late selection results', async()=>{
 const f=fixture(); f.bots[0]!.attentionCount=2; f.bots[1]!.attentionCount=1;
 const base=f.fetch.getMockImplementation()!, pending=Promise.withResolvers<Response>();
 f.fetch.mockImplementation(async (url,options)=>String(url).endsWith('/attention/seen')?pending.promise:base(url,options));
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
 const view=mount(botId());
 await act(async()=>{}); expect(f.fetch.mock.calls.some(([,o])=>o?.method==='POST')).toBe(false);
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
 view.select(botId(),false); fireEvent(document,new Event('visibilitychange'));
 await act(async()=>{}); expect(f.fetch.mock.calls.some(([,o])=>o?.method==='POST')).toBe(false);
 view.select(botId(),true);
 await waitFor(()=>expect(f.fetch.mock.calls.filter(([,o])=>o?.method==='POST')).toHaveLength(1));
 view.select(null);
 await act(async()=>pending.resolve(botResponse({targetBotId:botId()})));
 expect(screen.getByLabelText('2 items need your attention')).toBeVisible();
 expect(screen.queryByText('Could not confirm that these items were seen.')).toBeNull();
});

it('keeps reports arriving after a zero-count opening until the conversation is opened again', async()=>{
 vi.useFakeTimers({toFake:['setInterval','clearInterval']});
 try {
  const f=fixture(), base=f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url,options)=>{
   if(String(url).endsWith('/attention/seen')) { f.bots[0]!.attentionCount=0; return botResponse({targetBotId:botId()}); }
   return base(url,options);
  });
  const view=mount(botId());
  await act(async()=>{});
  expect(screen.getByRole('heading',{name:'Assistant 1'})).toBeVisible();
  expect(document.querySelector('.bot-attention-count')).toBeNull();
  f.bots[0]!.attentionCount=1;
  await act(async()=>{vi.advanceTimersByTime(5_000);});
  expect(screen.getByLabelText('1 items need your attention')).toBeVisible();
  expect(f.fetch.mock.calls.some(([,options])=>options?.method==='POST')).toBe(false);
  view.select(null);
  view.select(botId());
  await act(async()=>{});
  expect(f.fetch.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(1);
  expect(document.querySelector('.bot-attention-count')).toBeNull();
 } finally { vi.useRealTimers(); }
});

it('waits for the first confirmed count before consuming an opening', async()=>{
 const f=fixture(); f.bots[0]!.attentionCount=1;
 const base=f.fetch.getMockImplementation()!, firstDetail=Promise.withResolvers<Response>();
 let detailReads=0;
 f.fetch.mockImplementation(async (url,options)=>{
  if(String(url).endsWith('/attention/seen')) { f.bots[0]!.attentionCount=0; return botResponse({targetBotId:botId()}); }
  if(String(url).endsWith(`/me/bots/${botId()}`) && detailReads++===0) return firstDetail.promise;
  return base(url,options);
 });
 mount(botId());
 await screen.findByLabelText('1 items need your attention');
 expect(f.fetch.mock.calls.some(([,options])=>options?.method==='POST')).toBe(false);
 await act(async()=>firstDetail.resolve(botResponse(f.bots[0])));
 expect(f.fetch.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(1);
 expect(document.querySelector('.bot-attention-count')).toBeNull();
});
