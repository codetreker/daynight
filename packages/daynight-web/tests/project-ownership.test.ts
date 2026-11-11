import { parseTaskSync } from '../src/api/task-sync';
import { taskSyncFixture } from './helpers/taskSync';
import { expect, it } from 'vitest';
import { parseMembers, parseProjectAccess, parseUser, decodeMembersJson } from '../src/api/auth-parse';
import { parseTeamRef } from '../src/api/team-parse';
import { project, parseProjectPage, parseTaskGraph } from '../src/api/parse';
import { decodeProjectJson, decodeProjectPageJson, decodeTaskGraphJson } from '../src/api/project-json';
import { detailFixture, graphFixture } from './helpers/taskDetail';
import { directAccessFixture, TEST_VIEWER_ID } from './helpers/taskSync';
import { stringifyWireJson, wireResponse } from './helpers/wireJson';

const projectId = '00000000-0000-4000-8000-000000000101';
const taskId = '00000000-0000-4000-8000-000000000102';
const exact = 9_007_199_254_740_993n;
const access = { ...directAccessFixture(projectId), teamRole: 'admin' as const, canTransfer: true, effectiveRole: 'admin' as const, ownership: { ...directAccessFixture(projectId).ownership, version: exact } };
const graph = graphFixture([detailFixture(projectId, taskId)]);
const intrinsic = { ...graph.project, ownership: access.ownership };
const user = { id: TEST_VIEWER_ID, name: null, email: null, emailVerified: null, avatarUrl: null, personalTeam: access.ownerTeam };

it('keeps exact ownership versions in every Project transport and strips actor data from intrinsic projections', async () => {
  const full = { ...intrinsic, access, ownerTeam: access.ownerTeam };
  expect(project(await decodeProjectJson(wireResponse(full)))).toEqual(intrinsic);
  expect(parseProjectPage(await decodeProjectPageJson(wireResponse({ items: [full], nextCursor: null }))).items).toEqual([intrinsic]);
  expect(parseTaskGraph(await decodeTaskGraphJson(wireResponse({ ...graph, project: full })), projectId).project).toEqual(intrinsic);
  expect(intrinsic.ownership.version).toBe(exact);
  for (const ownership of [undefined, null, { teamId: access.ownerTeam.id, version: 0n }, { teamId: access.ownerTeam.id, version: Number(exact) }]) {
    expect(() => project({ ...intrinsic, ownership })).toThrow();
  }
});

it('requires a complete strict Personal reference from /me', () => {
  expect(parseUser(user)).toEqual(user);
  for (const personalTeam of [undefined, null, { ...user.personalTeam, id: 'invalid' }, { ...user.personalTeam, kind: 'ordinary', name: 'Team' }, { ...user.personalTeam, name: 'Personal' }, { ...user.personalTeam, future: true }]) {
    expect(() => parseUser({ ...user, personalTeam })).toThrow();
  }
  expect(() => parseUser({ ...user, future: true })).toThrow();
});

it('decodes independent exact actor ownership and grant versions in the members snapshot', async () => {
  const participant = { userId: TEST_VIEWER_ID, profile: { name: null, email: null, avatarUrl: null }, effectiveRole: 'admin', inheritedFrom: { team: access.ownerTeam, role: 'admin' }, directGrant: { ...access.directGrant!, version: 9_223_372_036_854_775_807n } };
  const result = parseMembers(await decodeMembersJson(wireResponse({ actorAccess: access, items: [participant] })), projectId, TEST_VIEWER_ID);
  expect(result.actorAccess.ownership.version).toBe(exact);
  expect(result.items[0]!.directGrant!.version).toBe(9_223_372_036_854_775_807n);
  expect(result.items[0]!.inheritedFrom).toEqual(participant.inheritedFrom);
  expect(() => parseMembers({ actorAccess: access, items: [{ ...participant, inheritedFrom: { ...participant.inheritedFrom, team: { ...access.ownerTeam, name: 'Wrong' } } }] }, projectId)).toThrow();
  expect(() => parseMembers({ items: [participant] }, projectId)).toThrow();
});

it('rejects contradictions between effective permission, owner identity and its real sources', () => {
  for (const changes of [{ projectId: taskId }, { ownership: { ...access.ownership, teamId: taskId } }, { canTransfer: false }, { effectiveRole: 'member' }, { teamRole: null, directGrant: null }]) {
    expect(() => parseProjectAccess({ ...access, ...changes }, projectId, TEST_VIEWER_ID)).toThrow();
  }
});


it('retains raw Unicode Team names and rejects only malformed, NUL or Unicode White_Space-only names', () => {
  for (const name of ['\uFEFF', '  名称  ', 'same name']) expect(parseTeamRef({ id: access.ownerTeam.id, kind: 'ordinary', name }).name).toBe(name);
  for (const name of ['', '\u0085', '\u2000 \n', '\uD800', 'a\0b']) expect(() => parseTeamRef({ id: access.ownerTeam.id, kind: 'ordinary', name })).toThrow();
});


it('requires task-sync actor access and intrinsic Project to describe the same ownership snapshot', () => {
  const wireSync = taskSyncFixture({ ...graph, project: intrinsic }, { actorAccess: access, versionForTask: () => 1n });
  expect(parseTaskSync(wireSync, projectId, TEST_VIEWER_ID).actorAccess.ownership).toEqual(intrinsic.ownership);
  for (const ownership of [{ ...access.ownership, version: exact + 1n }, { ...access.ownership, teamId: taskId }]) {
    expect(() => parseTaskSync({ ...wireSync, actorAccess: { ...access, ownership, ownerTeam: { ...access.ownerTeam, id: ownership.teamId } } }, projectId, TEST_VIEWER_ID)).toThrow();
  }
});


it('uses final escaped ownership and access fields while leaving unrelated nested versions under native JSON semantics', async () => {
  const ownershipSource = `{"teamId":"${access.ownership.teamId}","version":1e0,"ver\\u0073ion":${exact}}`;
  const accessSource = stringifyWireJson(access).replace('"ownership":', '"ownership":null,"own\\u0065rship":');
  const full = stringifyWireJson({ ...intrinsic, access }).replace('"ownership":' + stringifyWireJson(intrinsic.ownership), '"ownership":null,"own\\u0065rship":' + ownershipSource)
    .replace('"access":' + stringifyWireJson(access), '"access":null,"acce\\u0073s":' + accessSource);
  const decoded = await decodeProjectJson(new Response(`${full.slice(0, -1)},"opaque":{"version":9007199254740993}}`)) as Record<string, unknown>;
  expect(project(decoded).ownership.version).toBe(exact);
  expect(parseProjectAccess(decoded.access, projectId, TEST_VIEWER_ID).ownership.version).toBe(exact);
  expect(decoded.opaque).toEqual(JSON.parse('{"version":9007199254740993}'));
  const participant = { userId: TEST_VIEWER_ID, profile: { name: null, email: null, avatarUrl: null }, effectiveRole: 'admin', inheritedFrom: { team: access.ownerTeam, role: 'admin' }, directGrant: access.directGrant };
  const membersSource = `{"items":null,"it\\u0065ms":[${stringifyWireJson(participant)}],"actorAccess":null,"actorAcce\\u0073s":${accessSource}}`;
  const members = parseMembers(await decodeMembersJson(new Response(membersSource)), projectId, TEST_VIEWER_ID);
  expect(members.actorAccess.ownership.version).toBe(exact);
  expect(members.items[0]!.directGrant!.version).toBe(access.directGrant!.version);
});
