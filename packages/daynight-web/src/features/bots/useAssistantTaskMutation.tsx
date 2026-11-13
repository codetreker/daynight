import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError, authRequestsPaused } from '../../api/client';
import { AssistantTaskWriteUnknown, getAssistantTaskClaimOperation } from '../../api/assistant-tasks';
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
/** An original write and its unknown outcome remain observable across navigation. */
export function useAssistantTaskMutation(key:string,enabled:boolean,reload:(pending:AssistantTaskWriteUnknown|null)=>Promise<unknown>){
  const scope=useTaskCacheScope(),m=useAssistantTaskMessages(),state=stateFor(scope,key);
  const {busy,unknown}=useSyncExternalStore(state.subscribe,state.snapshot);
  const [error,setError]=useState<unknown>(null),[checked,setChecked]=useState(false);
  const live=useRef(true),current=useRef({scope,key,enabled,reload});current.current={scope,key,enabled,reload};
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  useEffect(()=>{setError(null);setChecked(false);},[scope,key,unknown]);
  const allowed=()=>live.current&&current.current.scope===scope&&current.current.key===key&&current.current.enabled&&!scope.isInvalidated&&!authRequestsPaused();
  const run=async(operation:(signal:AbortSignal)=>Promise<unknown>):Promise<boolean>=>{
    if(!allowed()||state.snapshot().busy||state.snapshot().unknown)return false;
    state.update({busy:true});setError(null);setChecked(false);
    try{
      await scope.ready(scope.signal);if(!allowed())return false;
      await operation(scope.signal);
      if(!allowed())return false;
      try{await current.current.reload(null);}catch(readError){if(allowed())setError(readError);}
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
    state.update({busy:true});setError(null);
    try{
      await scope.ready(scope.signal);if(!allowed())return;
      if(unknown?.operationId){
        try{await getAssistantTaskClaimOperation(unknown.taskId,unknown.operationId,scope.signal,assistantTaskAdmission(scope));}
        catch(failure){if(!(failure instanceof ApiError&&failure.status===404))throw failure; /* A missing receipt is an observation, not proof of failure. */}
      }
      await current.current.reload(unknown);if(allowed())setChecked(true);
    }catch(failure){if(allowed())setError(failure);}finally{state.update({busy:false});}
  };
  const notice=unknown?<div className="notice error" role="alert"><p>{m.unknown}</p><button className="button" type="button" disabled={busy||!enabled} onClick={()=>void check()}>{m.check}</button>{checked?<><p>{m.checked}</p><button className="button" type="button" disabled={!enabled} onClick={()=>{state.update({unknown:null});setChecked(false);}}>{m.reviewed}</button></>:null}{error?<p>{m.writeError}</p>:null}</div>:error?<div className="notice error" role="alert">{error instanceof ApiError&&error.status===409?m.conflict:m.writeError}{error instanceof ApiError&&error.requestId?<code>{error.requestId}</code>:null}</div>:null;
  return {run,busy,unknown,blocked:busy||unknown!==null||!enabled||scope.isInvalidated,notice};
}
