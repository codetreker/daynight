#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('1.0.0'); process.exit(0); }
if (args.includes('skill') && args.includes('list')) {
  const plugin = args.find(arg => arg.startsWith('--plugin-dir='));
  if (!plugin) throw Error('missing plugin');
  console.log(JSON.stringify([{name: 'daynight-review', enabled: true, source: 'plugin', path: path.join(plugin.slice('--plugin-dir='.length), 'skills', 'daynight-review')}]));
  process.exit(0);
}
(async () => {
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
  const sessionArg = args.find(arg => arg.startsWith('--session-id=') || arg.startsWith('--resume='));
  if (!sessionArg) throw Error('missing session');
  const session = sessionArg.split('=')[1];
  const match = prompt.match(/^Stable review identity: (daynight review=[^\n]+)$/m);
  if (!match) throw Error('missing review identity');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
  fs.mkdirSync(path.join(process.env.COPILOT_HOME, 'session-state', session), {recursive: true});
  fs.writeFileSync(path.join(process.env.COPILOT_HOME, 'session-state', session, 'fixture.jsonl'), 'fixture');
  fs.writeFileSync(process.env.REVIEW_FIXTURE_INPUT, JSON.stringify({prompt, sha, session}));
  if (process.env.REVIEW_FIXTURE_BLOCK && fs.existsSync(process.env.REVIEW_FIXTURE_BLOCK)) {
    fs.appendFileSync(process.env.REVIEW_FIXTURE_STARTS, `${process.pid}\n`);
    process.on('SIGTERM', () => {
      fs.writeFileSync(process.env.REVIEW_FIXTURE_STOPPED, String(process.pid));
      process.exit(0);
    });
    await new Promise(() => { setInterval(() => {}, 1_000); });
  }
  const publication = {id: 'fixture-review', author: {id: 'fixture-viewer'}, commit: {oid: sha}, body: '<!-- ' + match[1] + ' -->', state: 'APPROVED'};
  const temp = process.env.REVIEW_FIXTURE_PUBLICATION + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(publication));
  fs.renameSync(temp, process.env.REVIEW_FIXTURE_PUBLICATION);
  console.log('PR 1 Review Completed');
})().catch(error => { console.error(error); process.exitCode = 1; });
