import { expect, it } from 'vitest';
import { pendingBotCreation, rememberBotCreation } from '../src/features/bots/pending-creation';
import { createTaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { BOT_USER, botId } from './helpers/bots';
it('retains the original request across page remounts and reload reads without replay data',()=>{
 const scope=createTaskCacheScope({userId:BOT_USER,onIdentityMismatch:()=>{}}),request={id:botId(),name:'Original'};
 rememberBotCreation(scope,request);expect(pendingBotCreation(scope)).toEqual(request);
 const other=createTaskCacheScope({userId:BOT_USER,onIdentityMismatch:()=>{}});expect(pendingBotCreation(other)?.id).toBe(request.id);
 rememberBotCreation(other,null);scope.dispose();other.dispose();
});
it('keeps an in-memory identity when sessionStorage is unavailable and clears on access loss',()=>{
 const scope=createTaskCacheScope({userId:BOT_USER,onIdentityMismatch:()=>{}}),request={id:botId(),name:'Original'};
 const storage=Object.getOwnPropertyDescriptor(window,'sessionStorage')!;
 Object.defineProperty(window,'sessionStorage',{configurable:true,get(){throw Error('disabled');}});
 try {rememberBotCreation(scope,request);expect(pendingBotCreation(scope)).toEqual(request);scope.dispose();expect(pendingBotCreation(scope)).toBeNull();}
 finally{Object.defineProperty(window,'sessionStorage',storage);}
});
it('clears a cold retained identity on account cleanup before the Bot page is mounted',async()=>{
 const {clearPendingBotCreation}=await import('../src/features/bots/pending-creation');
 window.sessionStorage.setItem(`daynight.bot.creation:${BOT_USER}`,botId());
 clearPendingBotCreation(BOT_USER);
 const scope=createTaskCacheScope({userId:BOT_USER,onIdentityMismatch:()=>{}});expect(pendingBotCreation(scope)).toBeNull();scope.dispose();
});
it('retains confirmed results independently until each is consumed or its scope is disposed', async () => {
 const { confirmedBotCreations, rememberConfirmedBotCreation, forgetConfirmedBotCreation } = await import('../src/features/bots/pending-creation');
 const scope=createTaskCacheScope({userId:BOT_USER,onIdentityMismatch:()=>{}});
 const first={id:botId(11),name:'First'}, second={id:botId(12),name:'Second'};
 const bot={} as import('../src/api/bots').Bot;
 rememberBotCreation(scope,first); rememberConfirmedBotCreation(scope,first,bot);
 rememberBotCreation(scope,second); rememberConfirmedBotCreation(scope,second,bot);
 expect(confirmedBotCreations(scope).map(value=>value.request.id)).toEqual([first.id,second.id]);
 forgetConfirmedBotCreation(scope,first.id);
 expect(confirmedBotCreations(scope).map(value=>value.request.id)).toEqual([second.id]);
 scope.dispose(); expect(confirmedBotCreations(scope)).toEqual([]);
});
it('notifies a replacement form when the original request receives a late confirmation', async () => {
 const { confirmedBotCreations, rememberConfirmedBotCreation, subscribeConfirmedBotCreations } = await import('../src/features/bots/pending-creation');
 const scope=createTaskCacheScope({userId:BOT_USER,onIdentityMismatch:()=>{}}), request={id:botId(13),name:'Original'};
 rememberBotCreation(scope,request);
 const observed: string[][]=[];
 const unsubscribe=subscribeConfirmedBotCreations(scope,()=>observed.push(confirmedBotCreations(scope).map(value=>value.request.id)));
 rememberConfirmedBotCreation(scope,request,{} as import('../src/api/bots').Bot);
 expect(observed).toEqual([[request.id]]);
 unsubscribe(); scope.dispose(); expect(observed).toHaveLength(1);
});
