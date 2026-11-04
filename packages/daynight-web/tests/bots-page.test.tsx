import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BotsPage } from '../src/features/bots/BotsPage';
import { createTaskCacheScope, TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { renderWithLocale } from './helpers/renderWithLocale';
import { BOT_USER, botDefinition, botDefaults, botId, botResponse, botError } from './helpers/bots';
import { parseAuthRoute } from '../src/app/router';
vi.mock('../src/features/bots/BotSessionHost', () => ({ useBotSessionCache: () => cache, BotSessionHost: ({ binding }: {binding: {botId:string}|null}) => <section data-testid="host">{binding?.botId ?? 'no binding'}</section> }));
const cache = { invalidateBot: vi.fn() };
const scopes: ReturnType<typeof createTaskCacheScope>[] = [];
afterEach(() => scopes.splice(0).forEach(scope => scope.dispose()));
function mount(bot: string|null = null) {
 const scope = createTaskCacheScope({userId: BOT_USER, onIdentityMismatch:vi.fn()}); scopes.push(scope);
 const node = (id: string|null) => <TaskCacheProvider scope={scope}><BotsPage botId={id} readEnabled /></TaskCacheProvider>;
 const result = renderWithLocale(node(bot), {locale:'en'}); return {...result, select:(id:string|null)=>result.rerender(node(id)), scope};
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
 const view=mount(botId(1)); const opener=await screen.findByRole('button',{name:'Assistant 1'});
 const host=screen.getByTestId('host'); expect(screen.queryByRole('complementary',{name:'Assistant details'})).toBeNull();
 fireEvent.click(opener);
 const panel=screen.getByRole('complementary',{name:'Assistant details'});
 expect(within(panel).getByText('/ordinary/directory')).toBeVisible();
 expect(within(panel).getByText('Machine 20')).toBeVisible();
 expect(within(panel).queryByRole('switch')).toBeNull();
 view.select(botId(2)); await screen.findByRole('button',{name:'Assistant 2'});
 expect(within(panel).getByText('/second/directory')).toBeVisible();
 expect(within(panel).queryByText('Assistant 1')).toBeNull();
 fireEvent.keyDown(within(panel).getByRole('button',{name:'Close assistant details'}),{key:'Escape'});
 expect(screen.queryByRole('complementary',{name:'Assistant details'})).toBeNull();
 expect(screen.getByRole('button',{name:'Assistant 2'})).toHaveFocus();
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
 fireEvent.click(await screen.findByRole('button',{name:'Assistant 1'}));
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
 const view=mount();fireEvent.click(screen.getByRole('button',{name:'Create assistant'}));
 await waitFor(()=>expect(screen.getByLabelText('Name')).toBeEnabled());
 fireEvent.change(screen.getByLabelText('Name'),{target:{value:'Unknown'}});
 await waitFor(()=>expect(screen.getAllByRole('button',{name:'Create assistant'})[1]).toBeEnabled());
 fireEvent.click(screen.getAllByRole('button',{name:'Create assistant'})[1]!);
 await screen.findByRole('button',{name:'Check creation'});await waitFor(()=>expect(screen.getByRole('button',{name:'Check creation'})).toBeEnabled());
 view.unmount();
 const restored=renderWithLocale(<TaskCacheProvider scope={view.scope}><BotsPage botId={null} readEnabled /></TaskCacheProvider>,{locale:'en'});
 fireEvent.click(screen.getByRole('button',{name:'Create assistant'}));expect(screen.queryByLabelText('Name')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Check creation'}));await screen.findByRole('alert');
 expect(creates).toBe(1);expect(f.fetch.mock.calls.some(([url])=>String(url).endsWith(submitted))).toBe(true);restored.unmount();
});
