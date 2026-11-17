/** One process-wide shutdown, retaining all financial and startup lifetimes. */
export function createServiceLifecycle({ maintenance, startup = Promise.resolve(), servers,
  stopPayments, market, storageHealthy = () => true, log = () => {},
}) {
  let stopping = null;
  function stop(signal) {
    if (stopping) return stopping; // Repeated signals never abandon accepted work.
    maintenance.close();
    log(`${signal}: no new work; waiting for accepted workflows and settlement`);
    stopping = (async () => {
      // Signals can arrive after a listener opens but before other services
      // finish initialization. Stop the complete resource set after startup.
      await startup;
      const listeners = servers();
      const service = market();
      service?.stop();
      const outcomes = await Promise.allSettled([
        stopPayments(),
        ...(service ? [service.done] : []),
      ]);
      await maintenance.waitForIdle();
      // Node's close() can reap sockets whose responses are ended but still
      // backpressured. Admitted POSTs include response finish, so close only now.
      const closed = listeners.map(server => new Promise(resolve => server.close(resolve)));
      // Unpaid GET/SSE watches are read-only and may otherwise wait indefinitely.
      // Paid POST handlers have reached their actual terminal state by now.
      for (const server of listeners) {
        server.closeReadOnlyStreams?.();
        server.closeIdleConnections?.();
      }
      await Promise.all(closed);
      const healthy = storageHealthy() === true;
      const failed = outcomes.some(result => result.status === "rejected"
        || (typeof result.value === "number" && result.value !== 0));
      if (!healthy) log("Shutdown drained, but persisted money state needs operator reconciliation");
      return { exitCode: failed || !healthy ? 1 : 0 };
    })();
    return stopping;
  }
  return { stop, isStopping: () => stopping !== null };
}

/** Aggregate private write health without copying paths, events or credentials. */
export function moneyStateStatus(states) {
  let ok = true, pendingWrites = 0;
  for (const state of states.filter(value => value != null)) {
    if (typeof state.ok !== "boolean" || !Number.isSafeInteger(state.pendingWrites) || state.pendingWrites < 0) return { ok: false, pendingWrites: null };
    ok &&= state.ok;
    pendingWrites += state.pendingWrites;
    if (!Number.isSafeInteger(pendingWrites)) return { ok: false, pendingWrites: null };
  }
  return { ok, pendingWrites };
}
