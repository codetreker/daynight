import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useBotRead } from '../src/features/bots/useBotRead';
import { useBotDetail } from '../src/features/bots/useBotDetail';
import { pauseAuthRequests, subscribeUnauthorized } from '../src/api/client';
import { createTaskCacheScope, TaskCacheProvider, type TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { BOT_USER, botDefinition, botError, botId } from './helpers/bots';
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
it('retains the confirmed value and its validity across admission pause and a pending recovery read',async()=>{
 const next=Promise.withResolvers<{name:string}>(), load=vi.fn().mockResolvedValueOnce({name:'same'}).mockReturnValueOnce(next.promise);
 const {result,rerender}=renderHook(({enabled})=>useBotRead('a',enabled,load),{...wrap(),initialProps:{enabled:true}});
 await waitFor(()=>expect(result.current.value).toEqual({name:'same'})); const original=result.current.value;
 rerender({enabled:false}); expect(result.current.value).toBe(original); expect(result.current.stale).toBe(false);
 rerender({enabled:true}); await waitFor(()=>expect(load).toHaveBeenCalledTimes(2));
 expect(result.current.value).toBe(original); expect(result.current.stale).toBe(false);
 await act(async()=>next.resolve({name:'same'})); await waitFor(()=>expect(result.current.busy).toBe(false));
 expect(result.current.value).toEqual(original); expect(result.current.stale).toBe(false);
});

it('owns one timer only while generic reads are admitted, including Strict Mode recovery', async () => {
 vi.useFakeTimers({toFake:['setInterval','clearInterval']});
 let visible: DocumentVisibilityState = 'hidden';
 vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible);
 const first = Promise.withResolvers<string>(), second = Promise.withResolvers<string>();
 const signals: AbortSignal[] = [];
 const load = vi.fn((_scope: TaskCacheScope, signal: AbortSignal) => { signals.push(signal); return signals.length === 1 ? first.promise : second.promise; });
 const f = wrap();
 const wrapper = ({children}: {children: ReactNode}) => <StrictMode><f.wrapper>{children}</f.wrapper></StrictMode>;
 const {result, rerender, unmount} = renderHook(({enabled, key}) => useBotRead(key, enabled, load), {wrapper, initialProps: {enabled: false, key: 'a'}});
 await act(async () => {});
 expect(vi.getTimerCount()).toBe(0); expect(load).not.toHaveBeenCalled();
 rerender({enabled: true, key: 'a'}); await act(async () => {});
 expect(vi.getTimerCount()).toBe(0); expect(load).not.toHaveBeenCalled();
 await act(async () => { visible = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });
 expect(vi.getTimerCount()).toBe(1); expect(load).toHaveBeenCalledTimes(1);
 act(() => { result.current.refresh(); vi.advanceTimersByTime(15_000); });
 expect(vi.getTimerCount()).toBe(1); expect(load).toHaveBeenCalledTimes(1);
 rerender({enabled: false, key: 'a'});
 expect(vi.getTimerCount()).toBe(0); expect(signals[0]!.aborted).toBe(true);
 act(() => result.current.refresh()); expect(load).toHaveBeenCalledTimes(1);
 rerender({enabled: true, key: 'b'}); await act(async () => {});
 expect(vi.getTimerCount()).toBe(1); expect(load).toHaveBeenCalledTimes(2);
 await act(async () => first.resolve('obsolete'));
 expect(result.current.value).toBeNull();
 act(() => { result.current.refresh(); vi.advanceTimersByTime(10_000); });
 expect(load).toHaveBeenCalledTimes(2);
 await act(async () => second.resolve('current')); expect(result.current.value).toBe('current');
 await act(async () => f.scope.invalidateScope());
 expect(vi.getTimerCount()).toBe(0); expect(result.current.value).toBeNull();
 unmount(); expect(vi.getTimerCount()).toBe(0);
});

it('stops detail timers and tickets for null, hidden and disabled targets while preserving cached data', async () => {
 vi.useFakeTimers({toFake:['setInterval','clearInterval']});
 let visible: DocumentVisibilityState = 'hidden';
 vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible);
 const bot = botDefinition(), delayed = Promise.withResolvers<typeof bot>(), recovered = Promise.withResolvers<typeof bot>();
 const signals: AbortSignal[] = [];
 const load = vi.fn((_id: string, _scope: TaskCacheScope, signal: AbortSignal) => {
   signals.push(signal); return signals.length === 1 ? Promise.resolve(bot) : signals.length === 2 ? delayed.promise : recovered.promise;
 });
 const f = wrap(), retained = new Set([bot.id]);
 const {result, rerender, unmount} = renderHook(({id, enabled}) => useBotDetail(id, enabled, retained, load), {
   ...f, initialProps: {id: null as string | null, enabled: true},
 });
 await act(async () => {}); expect(vi.getTimerCount()).toBe(0); expect(load).not.toHaveBeenCalled();
 await act(async () => { visible = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });
 expect(vi.getTimerCount()).toBe(0); expect(load).not.toHaveBeenCalled();
 rerender({id: bot.id, enabled: true}); await act(async () => {});
 expect(vi.getTimerCount()).toBe(1); expect(load).toHaveBeenCalledTimes(1); expect(result.current.value).toEqual(bot);
 act(() => vi.advanceTimersByTime(5_000)); await act(async () => {});
 expect(load).toHaveBeenCalledTimes(2); expect(result.current.busy).toBe(true);
 act(() => { result.current.refresh(); vi.advanceTimersByTime(10_000); }); expect(load).toHaveBeenCalledTimes(2);
 rerender({id: bot.id, enabled: false});
 expect(vi.getTimerCount()).toBe(0); expect(signals[1]!.aborted).toBe(true);
 expect(result.current.value).toEqual(bot); expect(result.current.error).toBeNull(); expect(result.current.busy).toBe(false);
 act(() => result.current.refresh()); expect(load).toHaveBeenCalledTimes(2);
 rerender({id: bot.id, enabled: true}); await act(async () => {});
 expect(vi.getTimerCount()).toBe(1); expect(load).toHaveBeenCalledTimes(3);
 await act(async () => delayed.resolve({...bot, name: 'Obsolete'}));
 expect(result.current.value).toEqual(bot); expect(result.current.busy).toBe(true);
 act(() => { result.current.refresh(); vi.advanceTimersByTime(10_000); });
 expect(load).toHaveBeenCalledTimes(3); expect(result.current.busy).toBe(true);
 await act(async () => { visible = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); });
 expect(vi.getTimerCount()).toBe(0); expect(signals[2]!.aborted).toBe(true); expect(result.current.value).toEqual(bot);
 await act(async () => recovered.resolve({...bot, name: 'Late recovery'}));
 expect(result.current.value).toEqual(bot);
 unmount(); expect(vi.getTimerCount()).toBe(0);
});

it('recreates active Strict Mode owners and releases both timers and signals on scope invalidation', async () => {
 vi.useFakeTimers({toFake:['setInterval','clearInterval']});
 vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
 const genericSignals: AbortSignal[] = [], detailSignals: AbortSignal[] = [];
 const generic = vi.fn((_scope: TaskCacheScope, signal: AbortSignal) => { genericSignals.push(signal); return new Promise<string>(() => {}); });
 const detail = vi.fn((_id: string, _scope: TaskCacheScope, signal: AbortSignal) => { detailSignals.push(signal); return new Promise<ReturnType<typeof botDefinition>>(() => {}); });
 const first = wrap(), second = wrap();
 const strictFirst = ({children}: {children: ReactNode}) => <StrictMode><first.wrapper>{children}</first.wrapper></StrictMode>;
 const strictSecond = ({children}: {children: ReactNode}) => <StrictMode><second.wrapper>{children}</second.wrapper></StrictMode>;
 const one = renderHook(() => useBotRead('a', true, generic), {wrapper: strictFirst});
 const two = renderHook(() => useBotDetail(botId(), true, new Set(), detail), {wrapper: strictSecond});
 await act(async () => {});
 expect(vi.getTimerCount()).toBe(2); expect(generic).toHaveBeenCalledTimes(1); expect(detail).toHaveBeenCalledTimes(1);
 expect(genericSignals[0]!.aborted).toBe(false); expect(detailSignals[0]!.aborted).toBe(false);
 await act(async () => { await first.scope.invalidateScope(); await second.scope.invalidateScope(); });
 expect(vi.getTimerCount()).toBe(0); expect(genericSignals[0]!.aborted).toBe(true); expect(detailSignals[0]!.aborted).toBe(true);
 expect(one.result.current.busy).toBe(false); expect(two.result.current.busy).toBe(false);
 one.unmount(); two.unmount();
});

it('refreshes idle reads on a visible visibility event without overlapping active reads or adding timers', async () => {
 vi.useFakeTimers({toFake:['setInterval','clearInterval']});
 vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
 const firstRead = Promise.withResolvers<string>(), nextRead = Promise.withResolvers<string>();
 const bot = botDefinition(), firstDetail = Promise.withResolvers<typeof bot>(), nextDetail = Promise.withResolvers<typeof bot>();
 const genericSignals: AbortSignal[] = [], detailSignals: AbortSignal[] = [];
 const generic = vi.fn((_scope: TaskCacheScope, signal: AbortSignal) => {
   genericSignals.push(signal); return genericSignals.length === 1 ? firstRead.promise : nextRead.promise;
 });
 const detail = vi.fn((_id: string, _scope: TaskCacheScope, signal: AbortSignal) => {
   detailSignals.push(signal); return detailSignals.length === 1 ? firstDetail.promise : nextDetail.promise;
 });
 const one = renderHook(() => useBotRead('a', true, generic), wrap());
 const two = renderHook(() => useBotDetail(bot.id, true, new Set(), detail), wrap());
 await act(async () => {});
 expect(generic).toHaveBeenCalledTimes(1); expect(detail).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(2);
 await act(async () => document.dispatchEvent(new Event('visibilitychange')));
 expect(genericSignals[0]!.aborted).toBe(false); expect(detailSignals[0]!.aborted).toBe(false);
 expect(generic).toHaveBeenCalledTimes(1); expect(detail).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(2);
 await act(async () => { firstRead.resolve('old'); firstDetail.resolve({...bot, name: 'Old'}); });
 await act(async () => document.dispatchEvent(new Event('visibilitychange')));
 expect(generic).toHaveBeenCalledTimes(2); expect(detail).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(2);
 expect(one.result.current.busy).toBe(true); expect(two.result.current.busy).toBe(true);
 await act(async () => { nextRead.resolve('current'); nextDetail.resolve(bot); });
 expect(one.result.current.value).toBe('current'); expect(two.result.current.value).toEqual(bot);
 one.unmount(); two.unmount(); expect(vi.getTimerCount()).toBe(0);
});

it('aborts the real detail fetch before a late 401 can notify unauthorized listeners', async () => {
 vi.useFakeTimers({toFake:['setInterval','clearInterval']});
 vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
 const pending = Promise.withResolvers<Response>(), unauthorized = vi.fn();
 const unsubscribe = subscribeUnauthorized(unauthorized);
 const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
   expect(init?.signal).toBeInstanceOf(AbortSignal); return pending.promise;
 });
 vi.stubGlobal('fetch', fetcher);
 try {
   const {result, rerender, unmount} = renderHook(({enabled}) => useBotDetail(botId(), enabled, new Set()), {...wrap(), initialProps: {enabled: true}});
   await act(async () => {}); expect(fetcher).toHaveBeenCalledTimes(1);
   const signal = fetcher.mock.calls[0]![1]!.signal!;
   rerender({enabled: false}); expect(signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
   await act(async () => pending.resolve(botError(401, 'unauthenticated')));
   expect(unauthorized).not.toHaveBeenCalled(); expect(result.current.error).toBeNull();
   unmount();
 } finally { unsubscribe(); }
});

it('does not call either loader after cancellation while scope readiness is pending', async () => {
 vi.useFakeTimers({toFake:['setInterval','clearInterval']});
 vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
 const generic = vi.fn().mockResolvedValue('value'), detail = vi.fn().mockResolvedValue(botDefinition());
 const one = renderHook(({enabled}) => useBotRead('a', enabled, generic), {...wrap(), initialProps: {enabled: true}});
 const two = renderHook(({enabled}) => useBotDetail(botId(), enabled, new Set(), detail), {...wrap(), initialProps: {enabled: true}});
 one.rerender({enabled: false}); two.rerender({enabled: false});
 await act(async () => {});
 expect(generic).not.toHaveBeenCalled(); expect(detail).not.toHaveBeenCalled();
 expect(one.result.current.busy).toBe(false); expect(two.result.current.busy).toBe(false);
 expect(vi.getTimerCount()).toBe(0);
 one.unmount(); two.unmount();
});

it('releases busy when authentication pauses before scope readiness returns', async () => {
 vi.useFakeTimers({toFake:['setInterval','clearInterval']});
 vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
 const generic = vi.fn().mockResolvedValue('value'), detail = vi.fn().mockResolvedValue(botDefinition());
 const one = renderHook(() => useBotRead('a', true, generic), wrap());
 const two = renderHook(() => useBotDetail(botId(), true, new Set(), detail), wrap());
 const resume = pauseAuthRequests();
 try {
   await act(async () => {});
   expect(generic).not.toHaveBeenCalled(); expect(detail).not.toHaveBeenCalled();
   expect(one.result.current.busy).toBe(false); expect(two.result.current.busy).toBe(false);
 } finally { resume(); one.unmount(); two.unmount(); }
 expect(vi.getTimerCount()).toBe(0);
});

it('clears busy on authentication pause and continues polling after the parent readmission', async () => {
 vi.useFakeTimers({toFake:['setInterval','clearInterval']});
 vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
 const pending = Promise.withResolvers<string>();
 const load = vi.fn().mockResolvedValueOnce('confirmed').mockReturnValueOnce(pending.promise)
   .mockRejectedValueOnce(Error('read failed')).mockResolvedValue('recovered');
 const {result, rerender, unmount} = renderHook(({enabled}) => useBotRead('a', enabled, load), {...wrap(), initialProps: {enabled: true}});
 await act(async () => {}); expect(result.current.value).toBe('confirmed');
 act(() => vi.advanceTimersByTime(5_000)); await act(async () => {});
 expect(load).toHaveBeenCalledTimes(2); expect(result.current.busy).toBe(true);
 const resume = pauseAuthRequests();
 try {
   act(() => vi.advanceTimersByTime(5_000));
   expect(result.current.busy).toBe(false); expect(result.current.value).toBe('confirmed');
   rerender({enabled: false}); expect(vi.getTimerCount()).toBe(0);
 } finally { resume(); }
 rerender({enabled: true}); await act(async () => {});
 expect(load).toHaveBeenCalledTimes(3); expect(result.current.value).toBe('confirmed');
 expect(result.current.error).toBeInstanceOf(Error); expect(result.current.stale).toBe(true);
 act(() => vi.advanceTimersByTime(5_000)); await act(async () => {});
 expect(load).toHaveBeenCalledTimes(4); expect(result.current.value).toBe('recovered');
 expect(result.current.error).toBeNull(); expect(result.current.stale).toBe(false);
 await act(async () => pending.resolve('obsolete')); expect(result.current.value).toBe('recovered');
 unmount(); expect(vi.getTimerCount()).toBe(0);
});
