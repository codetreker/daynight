import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import * as sessions from '../src/api/sessions';
import { pauseAuthRequests } from '../src/api/client';
import { BotsPage } from '../src/features/bots/BotsPage';
import { createTaskCacheScope, TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { renderWithLocale } from './helpers/renderWithLocale';
import { botBinding, botFixture, botOwner } from './helpers/bot-session';
import { botDefaults, botDefinition, botResponse } from './helpers/bots';

it('keeps real shared Session nodes and drafts across list selection and close/reopen without commands',async()=>{
 const fixtures=[botFixture(botBinding(1)),botFixture(botBinding(2))];
 const definitions=fixtures.map((fixture,n)=>({...botDefinition(n+1),id:fixture.binding.botId,ownerUserId:botOwner,sessionId:fixture.binding.sessionId,testExecutionId:fixture.binding.testExecutionId,roleConfiguration:{instructions:'role',revision:'v1',digest:'a'.repeat(64)},startupResult:{state:'ready',code:null}}));
 vi.spyOn(sessions,'createBotSessionApi').mockImplementation(binding=>fixtures.find(f=>f.binding.botId===binding.botId)!.api);
 const fetch=vi.fn(async(url:string|URL|Request)=>botResponse(String(url).includes('/defaults')?botDefaults():String(url).includes('?')?{items:definitions,nextCursor:null}:definitions.find(d=>String(url).endsWith(d.id)),botOwner));vi.stubGlobal('fetch',fetch);
 const scope=createTaskCacheScope({userId:botOwner,onIdentityMismatch:vi.fn()});
 const node=(id:string|null)=><TaskCacheProvider scope={scope}><BotsPage botId={id} readEnabled /></TaskCacheProvider>;
 const view=renderWithLocale(node(definitions[0]!.id),{locale:'en'});
 try{
  const a=await screen.findByRole('textbox',{name:'Message'});await waitFor(()=>expect(a).toBeEnabled());fireEvent.change(a,{target:{value:'draft A'}});
  const host=view.container.querySelector('.bot-session-host');
  const session=a.closest('.task-agent-session'), channels=vi.mocked(fixtures[0]!.api.channel).mock.calls.length;
  fireEvent.click(screen.getByRole('button',{name:'Assistant 1'}));
  expect(screen.getByRole('complementary',{name:'Assistant details'})).toBeVisible();
  fireEvent.keyDown(screen.getByRole('button',{name:'Close assistant details'}),{key:'Escape'});
  expect(screen.getByRole('textbox',{name:'Message'})).toBe(a);
  expect(a.closest('.task-agent-session')).toBe(session);
  expect(vi.mocked(fixtures[0]!.api.channel).mock.calls.length).toBe(channels);
  fireEvent.click(screen.getByRole('button',{name:'Enter Session fullscreen'}));
  expect(view.container.querySelector('.bot-conversation')).toHaveAttribute('data-session-fullscreen','true');
  fireEvent.click(screen.getByRole('button',{name:'Assistant 1'}));
  fireEvent.keyDown(screen.getByRole('button',{name:'Close assistant details'}),{key:'Escape'});
  expect(view.container.querySelector('.bot-conversation')).toHaveAttribute('data-session-fullscreen','true');
  fireEvent.keyDown(screen.getByRole('button',{name:'Assistant 1'}),{key:'Escape'});
  expect(view.container.querySelector('.bot-conversation')).not.toHaveAttribute('data-session-fullscreen');
  expect(screen.getByRole('textbox',{name:'Message'})).toBe(a);
  view.rerender(node(definitions[1]!.id));await waitFor(()=>expect(screen.getByRole('textbox',{name:'Message'})).not.toBe(a));
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
  resume(); resume=undefined; view.rerender(node(true));
  await waitFor(()=>expect(pending.length).toBeGreaterThanOrEqual(3));
  expect(screen.getByRole('textbox',{name:'Message'})).toBe(input); expect(screen.getByRole('menu')).toBe(menu);
  expect(view.container.querySelector('.session-timeline')).toBe(timeline); expect(input).toHaveValue('unfinished draft');
  await act(async()=>{for(const {url,request} of pending)request.resolve(botResponse(url.includes('/defaults')?botDefaults():url.includes('?')?{items:[definition],nextCursor:null}:definition,botOwner));});
  await waitFor(()=>expect(screen.getByRole('button',{name:'Send'})).toBeEnabled());
  expect(screen.getByRole('textbox',{name:'Message'})).toBe(input); expect(screen.getByRole('menu')).toBe(menu);
  expect(vi.mocked(fixture.api.channel)).toHaveBeenCalledTimes(channelCount);
  expect(fixture.api.command).not.toHaveBeenCalled();
  expect(fetch.mock.calls.every(([, options])=>!options?.method || options.method==='GET')).toBe(true);
 }finally{resume?.();view.unmount();scope.dispose();}
});
