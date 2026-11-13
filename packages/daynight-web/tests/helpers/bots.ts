export const BOT_USER = '10000000-0000-4000-8000-000000000001';
export const BOT_TIME = '2026-11-04T12:00:00Z';
export const botId = (n = 1) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const botConfiguration = (workerId = botId(20)) => ({ workerId, cwd: '/ordinary/directory', provider: 'codex' as const, model: null as string | null, args: [] as string[] });
export const botDefinition = (n = 1) => ({
  id: botId(n), ownerUserId: BOT_USER, workerId: botId(20), name: `Assistant ${n}`, version: '1', creationOrder: String(n), attentionCount: 0,
  requestedOverrides: {}, resolvedConfiguration: botConfiguration(), roleConfiguration: null,
  sessionId: null as string | null, testExecutionId: null as string | null,
  startupResult: { state: 'pending' as 'pending' | 'ready' | 'failed', code: null as string | null }, deletion: null,
  createdAt: BOT_TIME, updatedAt: BOT_TIME,
});
export const botWorkerDefaults = (n = 20) => ({
  workerId: botId(n), machine: { id: botId(100 + n), name: `Machine ${n}` }, platform: 'macos' as const,
  state: 'available' as const, reason: null, configuration: botConfiguration(botId(n)),
  providers: (['codex', 'claude', 'copilot'] as const).map(provider => ({ provider, available: true, reason: null, model: null, args: [] as string[] })),
});
export const botDefaults = () => ({ observedAt: BOT_TIME, workerId: botId(20), configuration: botConfiguration(), reason: null, workers: [botWorkerDefaults()] });
export const botResponse = (value: unknown, principal: string | null = BOT_USER, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', 'Daynight-Bot-Attention': '1', ...(principal === null ? {} : { 'Daynight-User-ID': principal }) },
});
export const botError = (status: number, code: string, principal: string | null = BOT_USER) => botResponse({ error: { code, message: 'Bot request failed.', requestId: 'bot-request' } }, principal, status);

export const botAttentionHeaders = (requestHeaders: Readonly<Record<string, string>>, status = 200): Record<string, string> =>
  status === 200 && requestHeaders['daynight-bot-attention'] === '1' ? { 'Daynight-Bot-Attention': '1' } : {};
