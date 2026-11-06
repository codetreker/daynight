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
