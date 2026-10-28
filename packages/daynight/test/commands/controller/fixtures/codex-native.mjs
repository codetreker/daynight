import { createInterface } from 'node:readline';
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
let waiting = null, holdResponse = false;
for await (const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line);
 if(m.method==='initialize')out({id:m.id,result:{}});
 if(process.env.EXPECT_WORKER_PERMISSIONS && (m.method==='thread/start'||m.method==='thread/resume')) {
  const expected=process.env.EXPECT_WORKER_PERMISSIONS==='yes';
  if((m.params.sandbox==='danger-full-access')!==expected || (m.params.approvalPolicy==='never')!==expected) {out({id:m.id,error:{code:-32602,message:'Unexpected native permissions'}});continue;}
 }
 if(m.method==='thread/start'||m.method==='thread/resume')out({id:m.id,result:{thread:{id:'native-thread',cwd:process.cwd()}}});
 if(m.method==='thread/items/list')out({id:m.id,result:{data:[{type:'userMessage',id:'history-user',clientId:'persisted-operation',content:[{type:'text',text:'previous'}]}],nextCursor:null}});
 if(m.method==='thread/read')out({id:m.id,result:{thread:{id:'native-thread',turns:[]}}});
 if(m.method==='model/list')out({id:m.id,result:{data:[],nextCursor:null}});
 if(m.method==='configRequirements/read')out({id:m.id,result:{requirements:null}});
 if(m.method==='skills/list')out({id:m.id,result:{data:[]}});
 if(m.method==='turn/start'){
  const turn={id:'native-turn',status:'inProgress'},text=m.params.input[0].text;
  out({method:'turn/started',params:{threadId:'native-thread',turn}});
  out({method:'item/completed',params:{threadId:'native-thread',turnId:turn.id,item:{id:'user',type:'userMessage',clientId:m.params.clientUserMessageId,content:m.params.input}}});
  if(text==='approval'||text==='approval_cancel'||text==='approval_hold'){
   waiting=42;holdResponse=text==='approval_hold';out({id:m.id,result:{turn}});
   out({id:42,method:'item/commandExecution/requestApproval',params:{threadId:'native-thread',turnId:turn.id,itemId:'tool',command:'echo safe',availableDecisions:['accept',text==='approval_cancel'?'cancel':'decline']}});continue;
  }
  if(text==='cancel') {out({id:m.id,result:{turn}});continue;}
  out({method:'item/started',params:{threadId:'native-thread',turnId:turn.id,item:{id:'tool',type:'commandExecution',command:'echo safe',aggregatedOutput:''}}});
  out({method:'item/commandExecution/outputDelta',params:{threadId:'native-thread',itemId:'tool',delta:'safe output'}});
  out({method:'item/completed',params:{threadId:'native-thread',turnId:turn.id,item:{id:'answer',type:'agentMessage',text:'fixture answer'}}});
  out({method:'turn/completed',params:{threadId:'native-thread',turn:{...turn,status:'completed'}}});
  out({id:m.id,result:{turn}});
 }
 if(m.method==='turn/interrupt'){
  out({id:m.id,result:{}});
  setTimeout(()=>out({method:'turn/completed',params:{threadId:'native-thread',turn:{id:'native-turn',status:'interrupted'}}}),20);
 }
 if(waiting!==null && m.id===waiting && !m.method){
  if(holdResponse)continue;
  out({method:'item/completed',params:{threadId:'native-thread',item:{type:'agentMessage',id:'native-decision',text:'native-decision:'+m.result.decision}}});
  out({method:'serverRequest/resolved',params:{threadId:'native-thread',requestId:waiting}});waiting=null;
  out({method:'turn/completed',params:{threadId:'native-thread',turn:{id:'native-turn',status:'completed'}}});
 }
}
