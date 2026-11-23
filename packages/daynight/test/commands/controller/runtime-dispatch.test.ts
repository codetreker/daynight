import {test,expect,vi} from 'vitest';
vi.mock("../../../src/commands/controller/storage-lock.js", () => ({ acquireControllerStoragePermit: () => ({ journalFile: "/private/controller/journal.sqlite", owner: "fixture", release: () => {} }), controllerStorageConnectionIsOpen: () => false, isControllerStorageLockHeld: () => false }));
vi.mock("../../../src/commands/controller/storage-preparation.js", () => ({ prepareControllerStorage: () => ({ kind: "prepared", snapshot: null, legacyTimelineCleanupPending: false }) }));
vi.mock("../../../src/commands/controller/launch-tool-selection.js", () => ({ readLaunchToolSelection: async () => undefined }));
import {EventEmitter} from 'node:events';
const f=vi.hoisted(()=>({callbacks:null as any,receipt:vi.fn(),close:vi.fn(),gap:vi.fn(),writes:0,state:'accepted'}));
vi.mock('node:fs/promises',()=>({mkdir:async()=>{},realpath:async(v:string)=>v,chmod:async()=>{},unlink:async()=>{}}));
vi.mock('node:net',()=>({createServer:()=>{const s:any=new EventEmitter();s.listen=(_:unknown,cb:()=>void)=>queueMicrotask(cb);s.close=()=>{};return s}}));
vi.mock("../../../src/commands/controller/launch-ticket.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../../src/commands/controller/launch-ticket.js")>(),
  readLaunchTicket: async () => (await import("../../helpers/controller-runtime-ticket.js")).controllerRuntimeTicket(),
  controllerExecutionDirectory: () => "/private/controller"
}));
vi.mock('../../../src/commands/controller/process-proof.js',()=>({captureControllerProcessProof:async()=>({pid:1}),captureProcessProof:async()=>({pid:1})}));
vi.mock('../../../src/commands/controller/providers/codex.js',()=>({openCodexProvider:async()=>({send:async()=>({disposition:'started',turnId:'turn'}),close:f.close})}));
vi.mock('../../../src/commands/controller/relay.js',()=>({createControllerRelay:(_:unknown,__:unknown,callbacks:any)=>{f.callbacks=callbacks;return {flush:async()=>{},close:()=>{},connected:()=>true,authorize:async()=>{},receipt:f.receipt}}}));
vi.mock('../../../src/commands/controller/lifecycle-store.js',()=>({openControllerLifecycleStore:()=>({reconcileNativeIndexLease:async()=>{},listOperations:()=>[],patchSnapshot:()=>{},getSnapshot:()=>({nativeSessionId:'native',initialInputState:'confirmed',activity:'idle',currentTurnId:null,capabilities:{send:true,steer:true,cancel:true,respond:true}}),appendEvent:()=>{if(++f.writes===4)throw Error('Controller outbox capacity exceeded')},prepareOperation:()=>({operationId:'op',kind:'send_message',state:'accepted'}),assertInputCapacity:()=>{},markDispatching:()=>{f.state='dispatching'},getOperation:()=>({state:f.state}),recordOperation:(_:unknown,state:string)=>{if(f.state==='confirmed'&&state!=='confirmed')throw Error('A terminal controller operation cannot be replaced.');f.state=state;return {state}},markProjectionGap:f.gap,drainProjectionGap:()=>{},close:()=>{}})}));
vi.mock('../../../src/config/agent-cli-aliases.js',()=>({readAgentCliAliases:async()=>({})}));
vi.mock('../../../src/commands/controller/markdown/coordinator.js',()=>({createMarkdownCaptureCoordinator:()=>({tick:async()=>{},stop:async()=>{},invalidate:()=>{}})}));
vi.mock('../../../src/commands/controller/markdown/pipeline.js',()=>({createMarkdownTimelinePipeline:()=>({tick:async()=>{},stop:async()=>{}})}));
import {runController} from '../../../src/commands/controller/runtime.js';
test('a confirmed native receipt survives a state-projection failure and safely stops with a durable gap',async()=>{
const running=runController({homeDirectory:'/private',provider:'codex',launchId:'00000000-0000-4000-8000-000000000004'});
await vi.waitFor(()=>expect(f.writes).toBe(1));f.callbacks.onConnection(true);
await expect(f.callbacks.onCommand({sessionId:'00000000-0000-4000-8000-000000000002',claimId:'00000000-0000-4000-8000-000000000003',executionGeneration:'2',operationId:'op',kind:'send_message',payload:{content:[{type:'text',text:'hello'}],expectedTurnId:null}})).resolves.toBeUndefined();
expect(f.state).toBe('confirmed');expect(f.receipt).toHaveBeenCalledWith(expect.objectContaining({state:'confirmed'}));expect(f.gap).toHaveBeenCalledOnce();
await running;expect(f.close).toHaveBeenCalledOnce();
});
