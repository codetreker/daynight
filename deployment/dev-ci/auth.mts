import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { reserveLoopbackPort } from '../../packages/daynight-server/scripts/auth-fixture.mts';

type Configuration = {
  binary: string;
  directory: string;
  port: number;
  uid: number;
  gid: number;
  publicOrigin?: string;
  callbackURL?: string;
  appId?: string;
  appSecret?: string;
};

const [operation, directory, value] = process.argv.slice(2);
if (!directory || !path.isAbsolute(directory)) throw new Error('An absolute private dev-ci directory is required.');
const stateFile = path.join(directory, 'auth-state.json');
const environmentFile = path.join(directory, 'auth.env');
const descriptorFile = path.join(directory, 'auth-fixture.json');
const fixtureDirectory = path.join(directory, 'fixture');
const readyFile = path.join(fixtureDirectory, 'ready.json');

const privateWrite = async (file: string, contents: string) => {
  await writeFile(`${file}.next`, contents, { mode: 0o600 });
  await chmod(`${file}.next`, 0o600);
  await rename(`${file}.next`, file);
};
const quote = (entry: string | number) => {
  const text = String(entry);
  if (/[\r\n\0']/.test(text)) throw new Error('Unsupported character in private dev-ci configuration.');
  return `'${text}'`;
};
const save = async (configuration: Configuration) => {
  const environment: Record<string, string | number> = {
    DAYNIGHT_DEV_CI_FIXTURE_BINARY: configuration.binary,
    DAYNIGHT_DEV_CI_FIXTURE_DIRECTORY: configuration.directory,
    DAYNIGHT_DEV_CI_FIXTURE_PORT: configuration.port,
    DAYNIGHT_DEV_CI_FIXTURE_UID: configuration.uid,
    DAYNIGHT_DEV_CI_FIXTURE_GID: configuration.gid,
    DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN: 1,
    DAYNIGHT_ALLOW_LOOPBACK_HTTP: 1,
    DAYNIGHT_UNIAUTH_URL: `http://127.0.0.1:${configuration.port}`,
  };
  if (configuration.publicOrigin !== undefined) {
    environment.DAYNIGHT_PUBLIC_ORIGIN = configuration.publicOrigin;
    const preview = new URL(configuration.publicOrigin);
    const port = Number(preview.port);
    preview.port = String(port === 65535 ? 65534 : port + 1);
    environment.DAYNIGHT_PREVIEW_ORIGIN = preview.origin;
  }
  if (configuration.callbackURL !== undefined) environment.DAYNIGHT_UNIAUTH_CALLBACK_URL = configuration.callbackURL;
  if (configuration.appId !== undefined) environment.DAYNIGHT_UNIAUTH_APP_ID = configuration.appId;
  if (configuration.appSecret !== undefined) environment.DAYNIGHT_UNIAUTH_APP_SECRET = configuration.appSecret;
  await privateWrite(stateFile, `${JSON.stringify(configuration)}\n`);
  await privateWrite(environmentFile, Object.entries(environment).map(([key, entry]) => `${key}=${quote(entry)}\n`).join(''));
  if (configuration.publicOrigin !== undefined) await privateWrite(descriptorFile, `${JSON.stringify({
    origin: `http://127.0.0.1:${configuration.port}`,
    callbackURL: configuration.callbackURL,
    publicOrigin: configuration.publicOrigin,
  })}\n`);
};
const read = async () => JSON.parse(await readFile(stateFile, 'utf8')) as Configuration;

if (operation === 'init') {
  if (!value || !path.isAbsolute(value)) throw new Error('An absolute UniAuth fixture executable is required.');
  await access(value, constants.X_OK);
  if (!(await stat(value)).isFile()) throw new Error('The UniAuth fixture executable must be a file.');
  if (process.getuid === undefined || process.getgid === undefined) throw new Error('The dev-ci container fixture requires POSIX ownership.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await mkdir(fixtureDirectory, { recursive: true, mode: 0o700 });
  await save({ binary: value, directory: fixtureDirectory, port: await reserveLoopbackPort(), uid: process.getuid(), gid: process.getgid() });
} else if (operation === 'callback') {
  const origin = new URL(value!);
  if (origin.origin !== value || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port) throw new Error('An exact numeric-loopback product origin is required.');
  const configuration = await read();
  delete configuration.appId;
  delete configuration.appSecret;
  await rm(readyFile, { force: true });
  await save({ ...configuration, publicOrigin: origin.origin, callbackURL: `${origin.origin}/auth/callback` });
} else if (operation === 'verify') {
  const configuration = await read();
  const binary = await readFile(configuration.binary);
  const machine = value === 'amd64' ? 62 : value === 'arm64' ? 183 : undefined;
  if (binary.length < 20 || binary.subarray(0, 4).toString('hex') !== '7f454c46' || binary[4] !== 2 || binary[5] !== 1 || machine === undefined || binary.readUInt16LE(18) !== machine) throw new Error('The container UniAuth fixture must be a Linux ELF executable matching the production image architecture.');
} else if (operation === 'binary') {
  if (!value || !path.isAbsolute(value)) throw new Error('An absolute UniAuth fixture executable is required.');
  await access(value, constants.X_OK);
  if (!(await stat(value)).isFile()) throw new Error('The UniAuth fixture executable must be a file.');
  await save({ ...await read(), binary: value });
} else if (operation === 'port') {
  const configuration = await read();
  delete configuration.appId;
  delete configuration.appSecret;
  await save({ ...configuration, port: await reserveLoopbackPort() });
} else if (operation === 'ready') {
  const configuration = await read();
  const deadline = performance.now() + 15_000;
  let raw: string | undefined;
  while (raw === undefined && performance.now() < deadline) {
    try { raw = await readFile(readyFile, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (raw === undefined) await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (raw === undefined) throw new Error('The container UniAuth fixture did not become ready.');
  const info = await stat(readyFile);
  if (!info.isFile() || (info.mode & 0o777) !== 0o600) throw new Error('The UniAuth fixture readiness must be private.');
  let ready: { origin?: unknown; appId?: unknown; appSecret?: unknown };
  try { ready = JSON.parse(raw) as typeof ready; }
  catch { throw new Error('The UniAuth fixture readiness JSON is invalid.'); }
  if (ready.origin !== `http://127.0.0.1:${configuration.port}` || typeof ready.appId !== 'string' || ready.appId === '' || typeof ready.appSecret !== 'string' || ready.appSecret === '') throw new Error('The UniAuth fixture readiness metadata is invalid.');
  await save({ ...configuration, appId: ready.appId, appSecret: ready.appSecret });
  await rm(readyFile);
} else if (operation === 'redact') {
  const configuration = await read();
  delete configuration.appId;
  delete configuration.appSecret;
  await save(configuration);
  await rm(readyFile, { force: true });
  if (value !== '--keep-fixture') await rm(fixtureDirectory, { recursive: true, force: true });
} else throw new Error('Unknown dev-ci authentication lifecycle operation.');
