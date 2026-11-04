import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useBotRead } from '../src/features/bots/useBotRead';
import { createTaskCacheScope, TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { BOT_USER } from './helpers/bots';
const scopes: ReturnType<typeof createTaskCacheScope>[]=[];
afterEach(()=>{act(()=>scopes.splice(0).forEach(s=>s.dispose()));vi.useRealTimers();});
function wrap(){const scope=createTaskCacheScope({userId:BOT_USER,onIdentityMismatch:vi.fn()});scopes.push(scope);return {scope,wrapper:({children}:{children:ReactNode})=><TaskCacheProvider scope={scope}>{children}</TaskCacheProvider>};}
it('preserves last successful value with a stale marker on failure and supports retry',async()=>{
 const load=vi.fn().mockResolvedValueOnce('original').mockRejectedValueOnce(Error('read failed')).mockResolvedValue('new');
 const {result}=renderHook(()=>useBotRead('a',true,load),wrap()); await waitFor(()=>expect(result.current.value).toBe('original'));
 act(()=>result.current.refresh());await waitFor(()=>expect(result.current.error).toBeInstanceOf(Error));expect(result.current.value).toBe('original');expect(result.current.stale).toBe(true);
 act(()=>result.current.refresh());await waitFor(()=>expect(result.current.value).toBe('new'));expect(result.current.stale).toBe(false);
});
it('does not overlap polling, cancels hidden reads and refreshes on visibility return',async()=>{
 vi.useFakeTimers({toFake:['setInterval','clearInterval']});let visible:DocumentVisibilityState='visible';vi.spyOn(document,'visibilityState','get').mockImplementation(()=>visible);
 const signals:AbortSignal[]=[];let resolve!:(v:string)=>void;
 const load=vi.fn(async(_scope,signal:AbortSignal)=>{signals.push(signal);return new Promise<string>(r=>resolve=r);});
 const {result,unmount}=renderHook(()=>useBotRead('a',true,load),wrap()); await act(async()=>{});act(()=>vi.advanceTimersByTime(15_000));expect(load).toHaveBeenCalledTimes(1);
 await act(async()=>{visible='hidden';document.dispatchEvent(new Event('visibilitychange'));resolve('late');});expect(signals[0]!.aborted).toBe(true);expect(result.current.value).toBeNull();
 await act(async()=>{visible='visible';document.dispatchEvent(new Event('visibilitychange'));});expect(load).toHaveBeenCalledTimes(2);
 await act(async()=>resolve('current'));expect(result.current.value).toBe('current');unmount();expect(vi.getTimerCount()).toBe(0);
});
it('disables new reads and removes owner content on invalidation',async()=>{
 const load=vi.fn().mockResolvedValue('private'),f=wrap();const {result,rerender}=renderHook(({enabled})=>useBotRead('a',enabled,load),{...f,initialProps:{enabled:false}});
 await act(async()=>{});expect(load).not.toHaveBeenCalled();rerender({enabled:true});await waitFor(()=>expect(result.current.value).toBe('private'));
 await act(async()=>f.scope.invalidateScope());expect(result.current.value).toBeNull();expect(result.current.stale).toBe(true);act(()=>result.current.refresh());expect(load).toHaveBeenCalledTimes(1);
});
