/** Attempt every execution owner before propagating failures to Worker cleanup. */
export const shutdownWorkerExecutions = async (owners: {
  tasks?: () => Promise<void>;
  bots?: () => Promise<void>;
}): Promise<void> => {
  const results = await Promise.allSettled(Object.values(owners).map(async stop => { await stop(); }));
  const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Worker execution shutdown failed; unconfirmed resources are retained.");
};
