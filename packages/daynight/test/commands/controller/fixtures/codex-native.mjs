import { createInterface } from 'node:readline';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
let waiting = null, holdResponse = false, interruptUser = null, pendingSteer = null;
const interruptCase = process.env.CODEX_TEST_INTERRUPT;
const userItemId = process.env.CODEX_TEST_USER_ITEM_ID ?? 'user';
const interruptedHistory = id => ({ id, status: 'interrupted', error: null, items: [], itemsView: 'full', rootTurnId: id, startedAt: 1, completedAt: 2, durationMs: 1000 });
const sleep = { type: 'sleep', id: 'sleep-call', durationMs: 50000, startedAtMs: 1793708507841 };
const completedSleep = { ...sleep, completedAtMs: 1793708557843 };
let rollout;
for await (const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line);
 if(process.env.CODEX_TEST_REQUEST_LOG)appendFileSync(process.env.CODEX_TEST_REQUEST_LOG, JSON.stringify(m)+'\n');
 if(m.method==='initialize') {
  if(process.env.CODEX_TEST_INITIALIZE==='timeout')continue;
  if(process.env.CODEX_TEST_INITIALIZE==='reject') {out({id:m.id,error:{code:-32602,message:'Fixture initialization rejected /private/profile token=private-value'}});continue;}
  out({id:m.id,result:{}});
 }
 if(m.method==='config/read')out({id:m.id,result:{config:JSON.parse(process.env.CODEX_TEST_EFFECTIVE_CONFIG ?? '{}')}});
 if(process.env.EXPECT_WORKER_PERMISSIONS && (m.method==='thread/start'||m.method==='thread/resume')) {
  const expected=process.env.EXPECT_WORKER_PERMISSIONS==='yes';
  if((m.params.sandbox==='danger-full-access')!==expected || (m.params.approvalPolicy==='never')!==expected) {out({id:m.id,error:{code:-32602,message:'Unexpected native permissions'}});continue;}
 }
 if(process.env.EXPECT_AGENT_CLI_ENV && (m.method==='thread/start'||m.method==='thread/resume')) {
  const expected=JSON.parse(process.env.EXPECT_AGENT_CLI_ENV);
  if (Object.entries(expected).some(([key,value])=>m.params.config?.['shell_environment_policy.set.'+key]!==value)) {out({id:m.id,error:{code:-32602,message:'Agent CLI environment did not override native shell snapshot'}});continue;}
 }
 if(m.method==='thread/start'||m.method==='thread/resume') {
  if(process.env.CODEX_TEST_REJECT_ROLE && Object.hasOwn(m.params,'developerInstructions')) {
   out({id:m.id,error:{code:-32602,message:process.env.CODEX_TEST_REJECT_ROLE}});continue;
  }
  if(m.method==='thread/start'&&(m.params.model||m.params.config?.model_reasoning_effort)) {
   if(!process.env.CODEX_HOME)throw Error('Explicit-setting fixtures require an isolated CODEX_HOME');
   rollout=process.env.CODEX_TEST_ROLLOUT_PATH??join(process.env.CODEX_HOME,'sessions',`fixture-${process.pid}.jsonl`);
  }
  out({id:m.id,result:{...JSON.parse(process.env.CODEX_TEST_THREAD_SETTINGS ?? '{}'),...(process.env.CODEX_TEST_APPLY_EFFORT ? {reasoningEffort:m.params.config?.model_reasoning_effort ?? 'low'} : {}),thread:{id:'native-thread',cwd:process.cwd(),...(rollout?{path:rollout}:{})}}});
 }
 if(m.method==='thread/items/list') {
  if(process.env.CODEX_TEST_MARKDOWN_HISTORY_STATUS) {out({id:m.id,result:{data:[{turnId:'markdown-history',item:{type:'agentMessage',id:'history-body',text:'![image](local)'},completedAtMs:null}],nextCursor:null}});continue;}
  if(interruptCase) {
   if(interruptCase==='history-read-failure'){out({id:m.id,error:{code:-32603,message:'History unavailable'}});continue;}
   const user={type:'userMessage',id:userItemId,clientId:interruptUser?.clientId ?? '11111111-1111-4111-8111-111111111111',content:[{type:'text',text:'cancel'}]};
   let data=['missing-user','history-delayed'].includes(interruptCase)||interruptCase==='paged-history'&&m.params.turnId==='first-turn'?[]:[user];
   let nextCursor=null;
   if(interruptCase==='large-history') {
    if(!m.params.turnId || m.params.limit!==1){out({id:m.id,error:{code:-32602,message:'Expected bounded turn item query'}});continue;}
    data=m.params.cursor?[{type:'agentMessage',id:'answer',text:'last page'}]:[user];nextCursor=m.params.cursor?null:'item-page-two';
   }
   const result={data:data.map(item=>({turnId:m.params.turnId,item,startedAtMs:null,completedAtMs:null})),nextCursor,backwardsCursor:null};
   if(interruptCase==='history-delayed')setTimeout(()=>out({id:m.id,result}),200);else out({id:m.id,result});
  } else out({id:m.id,result:{data:[{type:'userMessage',id:'history-user',clientId:'persisted-operation',content:[{type:'text',text:'previous'}]},...(process.env.CODEX_TEST_SLEEP ? [completedSleep] : [])],nextCursor:null}});
 }
 if(m.method==='thread/turns/list') {
  if(process.env.CODEX_TEST_MARKDOWN_HISTORY_STATUS) {out({id:m.id,result:{data:[{id:'markdown-history',status:process.env.CODEX_TEST_MARKDOWN_HISTORY_STATUS}],nextCursor:null}});continue;}
  if(interruptCase==='large-history' && m.params.itemsView==='full'){out({id:m.id,error:{code:-32603,message:'Whole-turn history exceeds a bounded item page'}});continue;}
  if(interruptCase==='history-read-failure'){out({id:m.id,error:{code:-32603,message:'History unavailable'}});continue;}
  if(interruptCase==='history-delayed'){setTimeout(()=>out({id:m.id,result:{data:[{...interruptedHistory('native-turn'),items:[]}],nextCursor:null}}),200);continue;}
  if(!interruptCase){out({id:m.id,error:{code:-32601,message:'Method unavailable'}});continue;}
  const turn = interruptedHistory('native-turn');
  const user = { type: 'userMessage', id: userItemId, clientId: interruptUser?.clientId ?? '11111111-1111-4111-8111-111111111111', content: [{type: 'text', text: 'cancel'}] };
  if(interruptCase==='paged-history') {
   const next = m.params.cursor !== null;
   out({id:m.id,result:{data:[{...interruptedHistory(next ? 'second-turn' : 'first-turn'),items:next?[user]:[]}],nextCursor:next?null:'second',backwardsCursor:null}});
  } else out({id:m.id,result:{data:interruptCase?[{...turn,items:interruptCase==='missing-user'?[]:[user]}]:[],nextCursor:null,backwardsCursor:null}});
 }
 if(m.method==='thread/read') {
  if(rollout){mkdirSync(join(process.env.CODEX_HOME,'sessions'),{recursive:true});writeFileSync(rollout,JSON.stringify({type:'session_meta',payload:{id:'native-thread',cwd:process.cwd()}})+'\n');
   const db=new Database(join(process.env.CODEX_HOME,'state_5.sqlite'));db.exec('CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, model TEXT, reasoning_effort TEXT)');db.prepare('INSERT OR REPLACE INTO threads VALUES (?, ?, ?, ?, ?)').run('native-thread',rollout,process.cwd(),null,null);db.close();}
  if(process.env.CODEX_TEST_READ_ERROR)out({id:m.id,error:JSON.parse(process.env.CODEX_TEST_READ_ERROR)});
  else if(process.env.CODEX_TEST_EMPTY_READ_ERROR)out({id:m.id,error:{code:-32601,message:'list_turns is not supported yet'}});
  else out({id:m.id,result:{thread:{id:'native-thread',turns:[]}}});
 }
 if(m.method==='thread/settings/update') {
  const mode=process.env.CODEX_TEST_INITIAL_SETTINGS;
  if(mode==='reject')out({id:m.id,error:{code:-32602,message:'Initial settings rejected'}});
  else if(mode==='disconnect')process.exit(0);
  else if(mode==='async-error'){out({id:m.id,result:{}});out({method:'error',params:{threadId:'native-thread',error:{message:'Initial settings rejected asynchronously'}}});}
  else if(mode==='missing')out({id:m.id});
  else {out({id:m.id,result:mode?JSON.parse(mode):{}});if(rollout&&!mode){const db=new Database(join(process.env.CODEX_HOME,'state_5.sqlite'));db.prepare('UPDATE threads SET model = ?, reasoning_effort = ? WHERE id = ?').run(m.params.model??'default-model',m.params.effort??'medium','native-thread');db.close();}if(rollout&&!mode&&process.env.CODEX_TEST_ROLLOUT_MODE!=='deferred')appendFileSync(rollout,JSON.stringify({type:'event_msg',payload:{type:'thread_settings_applied',thread_id:'native-thread',thread_settings:{model:m.params.model??'default-model',collaboration_mode:{settings:{reasoning_effort:m.params.effort??'medium'}}}}})+'\n');}
 }
 if(m.method==='model/list')out({id:m.id,result:{data:JSON.parse(process.env.CODEX_TEST_MODELS ?? '[]'),nextCursor:null}});
 if(m.method==='configRequirements/read')out({id:m.id,result:{requirements:null}});
 if(m.method==='skills/list')out({id:m.id,result:{data:JSON.parse(process.env.CODEX_TEST_SKILLS ?? '[]')}});
 if(m.method==='turn/steer') {if(interruptCase?.startsWith('race:')){pendingSteer=m.id;continue;}if(interruptCase==='steer-rejected'){out({id:m.id,error:{code:-32602,message:'Steer rejected'}});continue;}out({id:m.id,result:{turnId:m.params.expectedTurnId}});continue;}
 if(m.method==='turn/start'){
  const turn={id:'native-turn',status:'inProgress'},text=m.params.input[0].text;
  out({method:'turn/started',params:{threadId:'native-thread',turn}});
  if(process.env.CODEX_TEST_EXIT_BURST) {
   const messages=Array.from({length:1000},()=>({method:'item/agentMessage/delta',params:{threadId:'native-thread',turnId:turn.id,itemId:'final-answer',delta:'received output '}}));
   if(process.env.CODEX_TEST_EXIT_BURST==='unsupported request')messages.push({id:42,method:'unsupported/request',params:{threadId:'native-thread'}});
   if(process.env.CODEX_TEST_EXIT_BURST==='foreign request')messages.push({id:42,method:'unsupported/request',params:{threadId:'other-thread'}});
   if(process.env.CODEX_TEST_EXIT_BURST==='invalid form')messages.push({id:42,method:'mcpServer/elicitation/request',params:{threadId:'native-thread',mode:'form',requestedSchema:{type:'array'}}});
   messages.push({method:'item/completed',params:{threadId:'native-thread',turnId:turn.id,item:{id:'final-answer',type:'agentMessage',text:'final answer before exit'}}});
   messages.push({method:'turn/completed',params:{threadId:'native-thread',turn:{...turn,status:'completed'}}});
   messages.push({id:m.id,result:{turn}});
   await new Promise((resolve,reject)=>process.stdout.write(messages.map(value=>JSON.stringify(value)+'\n').join(''),error=>error?reject(error):resolve()));
   break;
  }
  interruptUser={id:userItemId,type:'userMessage',clientId:m.params.clientUserMessageId,content:m.params.input};
  if(!['missing-user','completion-items','history-user','history-read-failure','history-delayed'].includes(interruptCase)) out({method:'item/completed',params:{threadId:'native-thread',turnId:turn.id,item:interruptUser}});
  const approvalCase=JSON.parse(process.env.CODEX_TEST_APPROVAL_CASES ?? '{}')[text];
  if(approvalCase){
   waiting=42;out({id:m.id,result:{turn}});
   for(const event of approvalCase.events ?? [])out(event);
   out({id:42,method:approvalCase.method,params:{threadId:'native-thread',turnId:turn.id,itemId:'patch',...approvalCase.params}});continue;
  }
  if(text==='approval'||text==='approval_cancel'||text==='approval_hold'){
   waiting=42;holdResponse=text==='approval_hold';out({id:m.id,result:{turn}});
   out({id:42,method:'item/commandExecution/requestApproval',params:{threadId:'native-thread',turnId:turn.id,itemId:'tool',command:'echo safe',availableDecisions:['accept',text==='approval_cancel'?'cancel':'decline']}});continue;
  }
  if(interruptCase==='foreign-thread')out({method:'turn/completed',params:{threadId:'other-thread',turn:{...turn,status:'interrupted'}}});
  if(interruptCase==='late-receipt' && text==='cancel') {out({method:'turn/completed',params:{threadId:'native-thread',turn:{...turn,status:'interrupted'}}});out({id:m.id,result:{turn}});continue;}
  if(text==='cancel') {out({id:m.id,result:{turn}});continue;}
  if(text==='sleep' && process.env.CODEX_TEST_SLEEP) {
   out({method:'item/started',params:{threadId:'native-thread',turnId:turn.id,item:sleep}});
   out({method:'item/completed',params:{threadId:'native-thread',turnId:turn.id,item:completedSleep}});
   out({method:'turn/completed',params:{threadId:'native-thread',turn:{...turn,status:'completed'}}});
   out({id:m.id,result:{turn}});continue;
  }
  out({method:'item/started',params:{threadId:'native-thread',turnId:turn.id,item:{id:'tool',type:'commandExecution',command:'echo safe',aggregatedOutput:''}}});
  out({method:'item/commandExecution/outputDelta',params:{threadId:'native-thread',itemId:'tool',delta:'safe output'}});
  out({method:'item/completed',params:{threadId:'native-thread',turnId:turn.id,item:{id:'answer',type:'agentMessage',text:'fixture answer'}}});
  out({method:'turn/completed',params:{threadId:'native-thread',turn:{...turn,status:'completed'}}});
  out({id:m.id,result:{turn}});
 }
 if(m.method==='turn/interrupt'){
  if(interruptCase?.startsWith('race:')) {
   const [,order,itemsView]=interruptCase.split(':');
   const completion={method:'turn/completed',params:{threadId:'native-thread',turn:{...interruptedHistory('native-turn'),itemsView,items:itemsView==='full'?[interruptUser]:[]}}};
   const rejection={id:pendingSteer,error:{code:-32602,message:'Racing steer rejected'}};
   const receipt={id:m.id,result:{}};
   const batch=messages=>process.stdout.write(messages.map(message=>JSON.stringify(message)+'\n').join(''));
   if(order==='reject-first')batch([rejection,completion,receipt]);
   else if(order==='complete-first')batch([completion,rejection,receipt]);
   else {batch([completion,receipt]);if(order!=='timeout')setTimeout(()=>out(order==='accept-delayed'?{id:pendingSteer,result:{turnId:'native-turn'}}:rejection),100);}
   continue;
  }

  const complete=()=>out({method:'turn/completed',params:{threadId:'native-thread',turn:{...interruptedHistory('native-turn'),status:['completed','failed'].includes(interruptCase)?interruptCase:'interrupted',error:interruptCase==='failed'?{message:'Unrelated native failure'}:null,itemsView:interruptCase==='completion-items'?'full':'notLoaded',items:interruptCase==='completion-items'?[interruptUser]:[]}}});
  if(interruptCase==='completion-first') {complete();complete();out({id:m.id,result:{}});} else {out({id:m.id,result:{}});setTimeout(complete,20);}
 }
 if(waiting!==null && m.id===waiting && !m.method){
  if(holdResponse)continue;
  out({method:'item/completed',params:{threadId:'native-thread',item:{type:'agentMessage',id:'native-decision',text:'native-decision:'+m.result.decision}}});
  out({method:'serverRequest/resolved',params:{threadId:'native-thread',requestId:waiting}});waiting=null;
  out({method:'turn/completed',params:{threadId:'native-thread',turn:{id:'native-turn',status:'completed'}}});
 }
}
process.stdin.destroy();
