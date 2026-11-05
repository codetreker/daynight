import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import * as sessions from '../src/api/sessions';
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
