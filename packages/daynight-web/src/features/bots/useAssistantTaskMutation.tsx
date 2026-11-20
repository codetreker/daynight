import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError, authRequestsPaused } from '../../api/client';
import { AssistantTaskWriteUnknown, getAssistantTaskClaimOperation, type AssistantTaskAdmission } from '../../api/assistant-tasks';
import { useTaskCacheScope, type TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { assistantTaskAdmission } from './assistant-task-data';
import { useAssistantTaskMessages } from './messages';
class MutationState {
  private value:{readonly busy:boolean;readonly unknown:AssistantTaskWriteUnknown|null}={busy:false,unknown:null};
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
 */
export function useAssistantTaskMutation(key:string,enabled:boolean,reload:(pending:AssistantTaskWriteUnknown|null)=>Promise<unknown>,readReceipt:ReceiptReader=getAssistantTaskClaimOperation,describeReceipt?:(receipt:unknown)=>string|null){
  const scope=useTaskCacheScope(),m=useAssistantTaskMessages(),state=stateFor(scope,key);
  const {busy,unknown}=useSyncExternalStore(state.subscribe,state.snapshot);
  const [error,setError]=useState<unknown>(null),[readError,setReadError]=useState<unknown>(null),[checked,setChecked]=useState<null|{readonly receipt:'confirmed'|'missing'|'none';readonly note:string|null;readonly read:boolean}>(null);
  const live=useRef(true),current=useRef({scope,key,enabled,reload,readReceipt,describeReceipt});current.current={scope,key,enabled,reload,readReceipt,describeReceipt};
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  useEffect(()=>{setError(null);setReadError(null);setChecked(null);},[scope,key,unknown]);
  const allowed=()=>live.current&&current.current.scope===scope&&current.current.key===key&&current.current.enabled&&!scope.isInvalidated&&!authRequestsPaused();
  const run=async(operation:(signal:AbortSignal)=>Promise<unknown>):Promise<boolean>=>{
    if(!allowed()||state.snapshot().busy||state.snapshot().unknown)return false;
    state.update({busy:true});setError(null);setReadError(null);setChecked(null);
    try{
      await scope.ready(scope.signal);if(!allowed())return false;
      await operation(scope.signal);
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
    state.update({busy:true});setError(null);setReadError(null);setChecked(null);
    // Every failure here is a failed read; the original write's outcome is unaffected by it.
    try{
      await scope.ready(scope.signal);if(!allowed())return;
      let observed:{readonly receipt:'confirmed'|'missing'|'none';readonly note:string|null}={receipt:'none',note:null};
      if(unknown?.operationId){
        try{const receipt=await current.current.readReceipt(unknown.taskId,unknown.operationId,scope.signal,assistantTaskAdmission(scope));observed={receipt:'confirmed',note:current.current.describeReceipt?.(receipt)??null};}
        catch(failure){if(!(failure instanceof ApiError&&failure.status===404))throw failure; /* A missing receipt is an observation, not proof of failure. */observed={receipt:'missing',note:null};}
      }
      // A confirmed receipt is published even when the refresh fails. Without a receipt, the current data must be read and shown
      // before the owner can acknowledge it, so a failed refresh leaves the result unchecked.
      try{await current.current.reload(unknown);}
      catch(failure){if(observed.receipt!=='confirmed')throw failure;if(allowed()){setReadError(failure);setChecked({...observed,read:false});}return;}
      if(allowed())setChecked({...observed,read:true});
    }catch(failure){if(allowed())setReadError(failure);}finally{state.update({busy:false});}
  };
  const notice=unknown?<div className="notice error" role="alert"><p>{m.unknown}</p><button className="button" type="button" disabled={busy||!enabled} onClick={()=>void check()}>{m.check}</button>{checked?<><p>{checked.receipt==='confirmed'?checked.read?m.confirmed:m.confirmedOnly:checked.receipt==='missing'?`${m.missing} ${m.checked}`:m.checked}</p>{checked.note?<p>{checked.note}</p>:null}<button className="button" type="button" disabled={!enabled} onClick={()=>{state.update({unknown:null});setChecked(null);}}>{m.reviewed}</button></>:null}{readError?<p>{m.readError}</p>:null}</div>:error?<div className="notice error" role="alert">{error instanceof ApiError&&error.status===409?m.conflict:m.writeError}{error instanceof ApiError&&error.requestId?<code>{error.requestId}</code>:null}</div>:readError?<div className="notice error" role="alert">{m.readError}</div>:null;
  return {run,busy,unknown,blocked:busy||unknown!==null||!enabled||scope.isInvalidated,notice};
}
