import { assertResponsePrincipal, request, requestId, type TaskResponseAdmission } from './client';
import { array, id, malformed, nonemptyString, record, string, timestamp } from './parse';
import { parseUsageSummary, usageReadJson, type UsageSummary } from './usage';

export type UsageAggregateScope = 'chain' | 'goal';
const memberCountKeys = ['total', 'withKnownUsage', 'complete', 'collecting', 'partial', 'unsupported', 'unavailable', 'noData', 'restricted'] as const;
export type UsageMemberCounts = Readonly<Record<typeof memberCountKeys[number], string>>;
export type UsageMissingMember = {
  readonly taskId: string;
  readonly title: string;
  readonly completeness: string;
  readonly reasonCodes: readonly string[];
};
export type UsageAggregate = {
  readonly scope: UsageAggregateScope;
  readonly scopeId: string;
  readonly membershipRevision: string;
  readonly summary: UsageSummary;
  readonly members: UsageMemberCounts;
  readonly missingMembers: readonly UsageMissingMember[];
  readonly nextMembersCursor: string | null;
  readonly observedAt: string;
};
const decimal = (value: unknown): string => {
  const parsed = string(value);
  return /^(0|[1-9][0-9]*)$/.test(parsed) ? parsed : malformed();
};
const completeness = (value: unknown): string => {
  const parsed = string(value);
  return ['complete', 'collecting', 'partial', 'unsupported', 'unavailable', 'no_data'].includes(parsed) ? parsed : malformed();
};

export const parseUsageAggregate = (value: unknown, scope: UsageAggregateScope, scopeId: string): UsageAggregate => {
  const data = record(value);
  if (data.scope !== scope || id(data.scopeId) !== scopeId || data.membershipPolicy !== 'current_members_excludes_deleted') return malformed();
  const counts = record(data.members);
  const members = Object.fromEntries(memberCountKeys.map(key => [key, decimal(counts[key])])) as UsageMemberCounts;
  if (BigInt(members.withKnownUsage) > BigInt(members.total) || members.restricted !== '0' ||
    ['complete', 'collecting', 'partial', 'unsupported', 'unavailable', 'noData'].reduce((sum, key) => sum + BigInt(members[key as keyof UsageMemberCounts]), 0n) !== BigInt(members.total)) return malformed();
  const missingMembers = array(data.missingMembers, value => {
    const member = record(value);
    return { taskId: id(member.taskId), title: string(member.title), completeness: completeness(member.completeness), reasonCodes: array(member.reasonCodes, nonemptyString) };
  });
  if (missingMembers.length > 100 || missingMembers.some(member => member.completeness === 'complete') || new Set(missingMembers.map(member => member.taskId)).size !== missingMembers.length) return malformed();
  return {
    scope, scopeId, membershipRevision: nonemptyString(data.membershipRevision), summary: parseUsageSummary(data.summary), members, missingMembers,
    nextMembersCursor: data.nextMembersCursor === null ? null : nonemptyString(data.nextMembersCursor), observedAt: timestamp(data.observedAt),
  };
};

export const getUsageAggregate = async (projectId: string, scope: UsageAggregateScope, scopeId: string, cursor: string | null, signal: AbortSignal, admission: TaskResponseAdmission): Promise<UsageAggregate> => {
  const project = requestId(projectId), target = requestId(scopeId);
  const query = cursor === null ? '' : `?${new URLSearchParams({ cursor })}`;
  const timeout = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded = AbortSignal.any([signal, timeout.signal]);
  try {
    const response = await request(`/api/projects/${project}/usage/v1/aggregates/${scope}/${target}${query}`, bounded, { headers: { Accept: 'application/json' } }, () => {
      timer = setTimeout(() => timeout.abort(new DOMException('The usage query timed out.', 'TimeoutError')), 15000);
    });
    assertResponsePrincipal(response, admission.userId, admission.onPrincipalMismatch);
    return await usageReadJson(response, bounded, value => response.status === 200 ? parseUsageAggregate(value, scope, target) : malformed());
  } finally { if (timer !== undefined) clearTimeout(timer); }
};
