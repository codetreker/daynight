export const personalTeamPage = (userId: string) => {
  const teamId = '00000000-0000-4000-8000-000000000701';
  const timestamp = '2026-10-22T10:00:00Z';
  return { items: [{ id: teamId, kind: 'personal', name: null, version: 1, createdAt: timestamp, updatedAt: timestamp,
    membership: { teamId, userId, role: 'admin', version: 1, createdAt: timestamp, updatedAt: timestamp } }], nextCursor: null };
};
