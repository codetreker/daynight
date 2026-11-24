import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect, topology, cli, cliEnvironment, startOwnedCommand } from './fixtures.ts';
import { verifyGoalWorker } from './subtask-compat-worker.ts';

type WorkerTopology = typeof topology & { oldCliEntry: string; workerVariant: 'candidate' | 'npm-0.72.0' };
const compat = topology as WorkerTopology;
if (!['candidate', 'npm-0.72.0'].includes(compat.workerVariant)) throw new Error('Goal Worker scenario requires an explicit artifact variant.');
test.use({ trace: 'off', screenshot: 'off' });

test(`Goal Worker five-edge claim and terminal ancestor: ${compat.workerVariant}`, async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto(`${topology.baseURL}/login`);
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click();
  await page.getByRole('button', { name: 'Authorize local identity', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Projects', exact: true })).toBeVisible();
  let output = '';
  let publish: (value: { uri: string; code: string }) => void = () => {};
  const authorization = new Promise<{ uri: string; code: string }>(resolve => { publish = resolve; });
  const login = await startOwnedCommand(process.execPath, [topology.cliEntry, 'login', '--no-browser'], {
    cwd: topology.cliConfigDirectory, env: cliEnvironment, timeoutMs: 120_000,
    onOutput: (_channel, chunk) => {
      output += chunk;
      const uri = output.match(/^Open (\S+)$/m)?.[1], code = output.match(/^Enter code: (\S+)$/m)?.[1];
      if (uri && code) publish({ uri, code });
    },
  });
  try {
    const device = await Promise.race([authorization, login.finished.then(() => { throw new Error('Device login exited before authorization.'); })]);
    await page.goto(`${device.uri}?user_code=${encodeURIComponent(device.code)}`);
    await page.getByRole('checkbox', { name: 'This code matches the one in my terminal', exact: true }).check();
    await page.getByRole('button', { name: 'Authorize CLI', exact: true }).click();
    expect((await login.finished).exitCode).toBe(0);
  } catch {
    await page.close().catch(() => {});
    throw new Error('Device authorization failed; sensitive diagnostics suppressed.');
  } finally { await login.stop(); }
  const configModule = pathToFileURL(path.join(path.dirname(topology.cliEntry), 'config/server.js')).href;
  const { loadServerConfiguration } = await import(configModule) as { loadServerConfiguration(paths: { stateDirectory: string; configFile: string }): Promise<{ serverToken?: string }> };
  const { serverToken } = await loadServerConfiguration({ stateDirectory: topology.cliConfigDirectory, configFile: path.join(topology.cliConfigDirectory, 'config.yml') });
  if (!serverToken) throw new Error('Candidate CLI did not retain its device credential.');
  await verifyGoalWorker({ entry: compat.workerVariant === 'candidate' ? topology.cliEntry : compat.oldCliEntry, variant: compat.workerVariant, token: serverToken, server: topology.baseURL, command: args => cli(args) });
});
