/** A gated, persistent process-group/Job Object leader for the Bot CLI probes. */
export const botCliProbeChildSource = String.raw`
const spawn = require(process.argv[1]);
let busy = false;
const send = message => { if (process.connected) process.send(message); };
// Keep an attributable leader until the owner stops the complete process scope.
setInterval(() => {}, 1000);
process.on('SIGTERM', () => {});
process.on('disconnect', () => {});
process.on('message', message => {
  if (busy || !message || message.type !== 'run' || typeof message.file !== 'string'
      || !Array.isArray(message.args) || message.args.some(value => typeof value !== 'string')
      || !message.environment || typeof message.environment !== 'object' || Array.isArray(message.environment)) {
    send({type:'failure'}); return;
  }
  busy = true;
  let child;
  try { child = spawn(message.file, message.args, {env:message.environment, stdio:['ignore','pipe','pipe'], windowsHide:true}); }
  catch { busy = false; send({type:'failure'}); return; }
  let stdout = [], stderr = [], bytes = 0, failed = false;
  const accept = (target, chunk) => {
    if (failed) return;
    bytes += chunk.length;
    if (bytes > 65536) { failed = true; send({type:'failure',code:'limit_exceeded'}); return; }
    target.push(chunk);
  };
  child.stdout.on('data', chunk => accept(stdout, chunk));
  child.stderr.on('data', chunk => accept(stderr, chunk));
  child.on('error', () => { failed = true; send({type:'failure'}); });
  child.on('close', (code, signal) => {
    busy = false;
    if (failed) return;
    send({type:'result', code, signal, stdout:Buffer.concat(stdout).toString('utf8'), stderr:Buffer.concat(stderr).toString('utf8')});
  });
});
send({type:'ready'});
`;
