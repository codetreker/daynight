import { expect } from '@playwright/test';
import { parseUser } from '../../src/api/auth-parse';
import { assertResponsePrincipal, json, requestId } from '../../src/api/client';
import { parseApiJson } from '../../src/api/json';
import { decodeTaskGraphJson } from '../../src/api/project-json';
import { parseTaskSync } from '../../src/api/task-sync';
import { graphFromTaskSync } from '../helpers/projectGraph';
import type { AuthenticatedAPI } from './authentication';

export const readProjectSnapshot = async (api: AuthenticatedAPI, projectId: string) => {
  const project = requestId(projectId);
  const identity = await api.get('/api/v1/me');
  expect(identity.status()).toBe(200);
  const user = parseUser(parseApiJson(await identity.text()));
  const response = await api.get(`/api/v1/projects/${project}/task-sync`, { headers: { 'Daynight-Worker-Protocol': '2' } });
  expect(response.status()).toBe(200);
  const body = await response.text();
  const nativeResponse = new Response(body, { status: response.status(), headers: response.headers() });
  assertResponsePrincipal(nativeResponse, user.id);
  const sync = await json(nativeResponse, new AbortController().signal, (value) => parseTaskSync(value, project), decodeTaskGraphJson);
  return { body, graph: graphFromTaskSync(sync) };
};
