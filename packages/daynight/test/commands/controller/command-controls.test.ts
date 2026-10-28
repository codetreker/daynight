import {test,expect} from 'vitest';
import {createNativeCommandQueue,assertControlCommand} from '../../../src/commands/controller/command-controls.js';
import type {ControllerSnapshot} from '../../../src/commands/controller/lifecycle-store.js';
import type {SessionCommand} from '../../../src/session/protocol.js';
const snapshot: Pick<ControllerSnapshot,"controls"|"activity"|"currentTurnId"> = {activity:'idle',currentTurnId:null,controls:{revision:'1',settings:[{id:'model',category:'model',label:'Model',description:null,scope:'session',value:'a',mutable:true,options:[{value:'a',label:'A'},{value:'b',label:'B'}]}],commands:[{id:'compact',name:'compact',description:'Compact',available:true,argumentHint:null}],settingsError:null,commandsError:null}};
const setting = {kind:'update_setting',payload:{settingId:'model',value:'b',expectedControlsRevision:'1'}} as Extract<SessionCommand,{kind:'update_setting'}>;
test('serializes native settings with sends while interrupt bypasses an awaiting confirmation',async()=>{
 const run=createNativeCommandQueue(),events:string[]=[];let release!:()=>void;
 const first=run('update_setting',async()=>{events.push('setting');await new Promise<void>(r=>release=r);});
 const second=run('send_message',async()=>{events.push('send');});
 await Promise.resolve();await run('cancel',async()=>{events.push('interrupt');});expect(events).toEqual(['setting','interrupt']);release();await Promise.all([first,second]);expect(events).toEqual(['setting','interrupt','send']);
});
test('rejects stale settings at actual native dispatch and recovers the queue after rejection',async()=>{
 const run=createNativeCommandQueue();assertControlCommand(setting,snapshot);
 const changed={...snapshot,controls:{...snapshot.controls!,revision:'2'}};
 await expect(run('update_setting',async()=>assertControlCommand(setting,changed))).rejects.toThrow('changed');
 await expect(run('send_message',async()=>42)).resolves.toBe(42);
 expect(()=>assertControlCommand({...setting,payload:{settingId:'model',value:'unsupported',expectedControlsRevision:'1'}},snapshot)).toThrow('not available');
});
test('rechecks discovered commands, idle turn and argument contract',()=>{
 const command={kind:'execute_command',payload:{commandId:'compact',arguments:'',expectedControlsRevision:'1',expectedTurnId:null}} as Extract<SessionCommand,{kind:'execute_command'}>;
 expect(()=>assertControlCommand(command,snapshot)).not.toThrow();
 expect(()=>assertControlCommand(command,{...snapshot,activity:'working',currentTurnId:'turn'})).toThrow();
 expect(()=>assertControlCommand({...command,payload:{commandId:'compact',arguments:'extra',expectedControlsRevision:'1',expectedTurnId:null}},snapshot)).toThrow();
 expect(()=>assertControlCommand({...command,payload:{commandId:'unknown',arguments:'',expectedControlsRevision:'1',expectedTurnId:null}},snapshot)).toThrow();
});
