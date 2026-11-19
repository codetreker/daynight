import { createLinuxProcessCapture } from "../controller/linux-process-proof.js";

/**
 * The helper persists its own birth proof before admitting extraction. Before
 * commit, a lost parent exits without native work; after commit the group leader
 * survives for proof-based recovery, even when the extractor has exited.
 */
export const toolExtractionChildSource = String.raw`
const fs = require('node:fs');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const [proofPath, preparationId] = process.argv.slice(1);
let committed = false;
const send = value => { if (process.connected) process.send(value); };
process.on('disconnect', () => { if (!committed) process.exit(0); });
process.on('SIGTERM', () => { if (!committed) process.exit(0); });
setInterval(() => {}, 1000);
(async () => {
let proof;
if (process.platform === 'linux') {
  const capture = (${createLinuxProcessCapture.toString()})(
    (file, timeout) => fs.promises.readFile(file, {encoding:'utf8',signal:AbortSignal.timeout(timeout)}),
    (pid, timeout) => new Promise((resolve,reject) => cp.execFile('ps', ['-p',String(pid),'-o','pid=','-o','ppid=','-o','pgid=','-o','stat=','-o','lstart=','-o','command='], {encoding:'utf8',timeout,maxBuffer:8*1024*1024,env:{...process.env,LC_ALL:'C'}}, (error,stdout) => error ? reject(error) : resolve(stdout))),
    text => crypto.createHash('sha256').update(text).digest('hex'));
  const state = await capture(process.pid, 5000);
  if (state.zombie || state.exiting || state.proof.processGroupId !== process.pid) process.exit(1);
  proof = state.proof;
} else {
const output = cp.execFileSync('ps', ['-p',String(process.pid),'-o','pid=','-o','ppid=','-o','pgid=','-o','lstart=','-o','command='], {encoding:'utf8',timeout:5000,env:{...process.env,LC_ALL:'C'}});
const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+([^\n]+)\s*$/u.exec(output);
if (!match || Number(match[1]) !== process.pid || Number(match[3]) !== process.pid) process.exit(1);
proof = {pid:process.pid,parentPid:Number(match[2]),processGroupId:Number(match[3]),startedAt:match[4].replace(/\s+/g,' '),commandHash:crypto.createHash('sha256').update(match[5].trim()).digest('hex')};
}
const data = JSON.stringify({schemaVersion:1,preparationId,proof});
const temp = proofPath+'.pending';
const fd = fs.openSync(temp,'wx',0o600); fs.writeFileSync(fd,data); fs.fsyncSync(fd); fs.closeSync(fd);
fs.linkSync(temp,proofPath); fs.unlinkSync(temp);
const dir = fs.openSync(path.dirname(proofPath),'r'); fs.fsyncSync(dir); fs.closeSync(dir);
process.on('message', message => {
  if (committed || !message || message.type !== 'commit' || message.preparationId !== preparationId
    || typeof message.file !== 'string' || !Array.isArray(message.args) || !message.environment) return;
  committed = true;
  let child;
  try { child = cp.spawn(message.file,message.args,{env:message.environment,stdio:['ignore','pipe','pipe']}); }
  catch { send({type:'result',ok:false}); return; }
  let bytes = 0, failed = false;
  const accept = chunk => { bytes += chunk.length; if (bytes > 65536 && !failed) { failed=true; send({type:'result',ok:false}); } };
  child.stdout.on('data',accept); child.stderr.on('data',accept);
  child.on('error',() => { failed=true; send({type:'result',ok:false}); });
  child.on('close',(code,signal) => { if (!failed) send({type:'result',ok:code===0&&signal===null}); });
});
send({type:'ready'});
})().catch(() => process.exit(1));
`;
