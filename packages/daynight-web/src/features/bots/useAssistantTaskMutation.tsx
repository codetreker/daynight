import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError, authRequestsPaused } from '../../api/client';
import { AssistantTaskWriteUnknown, getAssistantTaskClaimOperation, type AssistantTaskAdmission } from '../../api/assistant-tasks';
import { useTaskCacheScope, type TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { assistantTaskAdmission } from './assistant-task-data';
import { useAssistantTaskMessages } from './messages';
class MutationState {
  private value:{readonly busy:boolean;readonly refreshing:boolean;readonly unknown:AssistantTaskWriteUnknown|null}={busy:false,refreshing:false,unknown:null};
  /** Identifies the latest check so a superseded refresh cannot publish its result. */
  checks=0;
  /** Counts refreshes still running after their check released busy; any of them blocks new writes. */
  private refreshes=0;
  refresh(delta:1|-1){this.refreshes+=delta;this.update({refreshing:this.refreshes>0});}
  private listeners=new Set<()=>void>();
  snapshot=()=>this.value;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  update(patch:Partial<typeof this.value>){this.value={...this.value,...patch};for(const listener of this.listeners)listener();}
}
const states=new WeakMap<TaskCacheScope,Map<string,MutationState>>();
function stateFor(scope:TaskCacheScope,key:string){let map=states.get(scope);if(!map){map=new Map();states.set(scope,map);}let state=map.get(key);if(!state){state=new MutationState();map.set(key,state);}return state;}
type ReceiptReader=(taskId:string,operationId:string,signal:AbortSignal,admission:AssistantTaskAdmission)=>Promise<unknown>;
/**
 * An original write and its unknown outcome remain observable across navigation; readReceipt reads the receipt store that owns the write's operation ID.
 * A receipt proves the write was applied, while a missing receipt (404) stays inconclusive. describeReceipt adds what a confirmed receipt cannot restore.
 * enabled admits the owner to check and acknowledge an unknown outcome; writable additionally admits new writes. A fresh snapshot
 * is required for new writes and for acknowledging an unknown outcome without a receipt, but a confirmed receipt is independent of
 * the snapshot read, so a failing or stalled snapshot read never withholds checking or acknowledging it. A confirmed receipt is
 * published before its refresh settles; that refresh still blocks new writes until it completes.
 */
export function useAssistantTaskMutation(key:string,enabled:boolean,reload:(pending:AssistantTaskWriteUnknown|null)=>Promise<unknown>,readReceipt:ReceiptReader=getAssistantTaskClaimOperation,describeReceipt?:(receipt:unknown)=>string|null,writable=true){
  const scope=useTaskCacheScope(),m=useAssistantTaskMessages(),state=stateFor(scope,key);
  const {busy,refreshing,unknown}=useSyncExternalStore(state.subscribe,state.snapshot);
  const [error,setError]=useState<unknown>(null),[readError,setReadError]=useState<unknown>(null),[checked,setChecked]=useState<null|{readonly receipt:'confirmed'|'missing'|'none';readonly note:string|null;readonly read:boolean}>(null);
  const live=useRef(true),current=useRef({scope,key,enabled,writable,reload,readReceipt,describeReceipt});current.current={scope,key,enabled,writable,reload,readReceipt,describeReceipt};
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  useEffect(()=>{setError(null);setReadError(null);setChecked(null);},[scope,key,unknown]);
  const allowed=()=>live.current&&current.current.scope===scope&&current.current.key===key&&current.current.enabled&&!scope.isInvalidated&&!authRequestsPaused();
  const run=async(operation:(signal:AbortSignal)=>Promise<unknown>):Promise<boolean>=>{
    if(!allowed()||!current.current.writable||state.snapshot().busy||state.snapshot().refreshing||state.snapshot().unknown)return false;
    state.update({busy:true});setError(null);setReadError(null);setChecked(null);
    try{
      await scope.ready(scope.signal);if(!allowed())return false;
      await operation(scope.signal);
      // The write was admitted while writable; a snapshot read failing during it does not undo the accepted change.
      if(!allowed())return false;
      // The write was accepted; a failed refresh is a read failure, not a rejected change.
      try{await current.current.reload(null);}catch(failure){if(allowed())setReadError(failure);}
      return true;
    }catch(failure){
      if(!scope.isInvalidated&&failure instanceof AssistantTaskWriteUnknown)state.update({unknown:failure});
      else if(allowed()){
        setError(failure);
        if(failure instanceof ApiError&&failure.status===409){try{await current.current.reload(null);}catch{/* The owning read displays failures. */}}
      }
      return false;
    }finally{state.update({busy:false});}
  };
  const check=async()=>{
    if(!allowed()||state.snapshot().busy)return;
    const generation=++state.checks,target=unknown,latest=()=>allowed()&&state.checks===generation&&state.snapshot().unknown===target;
    state.update({busy:true});setError(null);setReadError(null);setChecked(null);
    // Every failure here is a failed read; the original write's outcome is unaffected by it.
    let released=false;
    try{
      await scope.ready(scope.signal);if(!allowed())return;
      if(target?.operationId){
        let receipt:{readonly value:unknown}|null;
        try{receipt={value:await current.current.readReceipt(target.taskId,target.operationId,scope.signal,assistantTaskAdmission(scope))};}
        catch(failure){if(!(failure instanceof ApiError&&failure.status===404))throw failure; /* A missing receipt is an observation, not proof of failure. */receipt=null;}
        if(receipt!==null){
          // A confirmed receipt does not depend on the refresh, which has no client deadline; publish it and release the check
          // before waiting, so a stalled refresh cannot withhold acknowledging it. The refresh keeps blocking new writes.
          const observed={receipt:'confirmed' as const,note:current.current.describeReceipt?.(receipt.value)??null};
          if(!latest())return;
          setChecked({...observed,read:false});released=true;state.refresh(1);state.update({busy:false});
          try{await current.current.reload(target);if(latest())setChecked({...observed,read:true});}
          catch(failure){if(latest())setReadError(failure);}
          return;
        }
        // Without a receipt, the current data must be read and shown before the owner can acknowledge it, so a failed refresh
        // leaves the result unchecked.
        await current.current.reload(target);
        if(latest())setChecked({receipt:'missing',note:null,read:true});
        return;
      }
      await current.current.reload(target);
      if(latest())setChecked({receipt:'none',note:null,read:true});
    }catch(failure){if(latest())setReadError(failure);}
    finally{
      if(released)state.refresh(-1);else state.update({busy:false});
    }
  };
  const notice=unknown?<div className="notice error" role="alert"><p>{m.unknown}</p><button className="button" type="button" disabled={busy||!enabled} onClick={()=>void check()}>{m.check}</button>{checked?<><p>{checked.receipt==='confirmed'?checked.read?m.confirmed:m.confirmedOnly:checked.receipt==='missing'?`${m.missing} ${m.checked}`:m.checked}</p>{checked.note?<p>{checked.note}</p>:null}<button className="button" type="button" disabled={!enabled||(checked.receipt!=='confirmed'&&!writable)} onClick={()=>{state.update({unknown:null});setChecked(null);}}>{m.reviewed}</button></>:null}{readError?<p>{m.readError}</p>:null}</div>:error?<div className="notice error" role="alert">{error instanceof ApiError&&error.status===409?m.conflict:m.writeError}{error instanceof ApiError&&error.requestId?<code>{error.requestId}</code>:null}</div>:readError?<div className="notice error" role="alert">{m.readError}</div>:null;
  return {run,busy,unknown,blocked:busy||refreshing||unknown!==null||!enabled||!writable||scope.isInvalidated,notice};
}
