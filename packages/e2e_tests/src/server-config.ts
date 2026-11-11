import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type ServerConfiguration = {
  listenAddress: string;
  publicOrigin: string;
  databaseURL: string;
  storageRoot: string;
  authURL: string;
  appId: string;
  appSecret: string;
  callbackURL: string;
};

export const writeServerConfig = async (root: string, values: ServerConfiguration): Promise<void> => {
  const configDirectory = path.join(root, 'config');
  await mkdir(configDirectory, { mode: 0o700 });
  // JSON is a YAML 1.2 flow document; serialize the whole mapping to preserve types and credentials.
  const configuration = {
    server: { listen_address: values.listenAddress, public_origin: values.publicOrigin, allow_http_test_origin: true },
    database: { url: values.databaseURL },
    storage: { root: values.storageRoot },
    uniauth: { url: values.authURL, app_id: values.appId, app_secret: values.appSecret, callback_url: values.callbackURL, allow_loopback_http: true },
  };
  await writeFile(path.join(configDirectory, 'config.yml'), `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
};
