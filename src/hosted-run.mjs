import { AsyncLocalStorage } from "node:async_hooks";

export const DEFAULT_HOSTED_RUN_MS = 30 * 60_000;
const context = new AsyncLocalStorage();

export function hostedRunTimeout(value = process.env.NANOODLE_RUN_TIMEOUT_MS ?? DEFAULT_HOSTED_RUN_MS) {
  if ((typeof value !== "number" && !(typeof value === "string" && /^\d+$/.test(value)))
      || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 24 * 3_600_000) {
    throw new TypeError("NANOODLE_RUN_TIMEOUT_MS must be a positive integer up to 86400000");
  }
  return Number(value);
}

function assertOpen(scope) {
  // Synchronous work can delay the timer callback. It must not earn extra
  // time or start another request merely by keeping the event loop busy.
  if (!scope.controller.signal.aborted && performance.now() >= scope.deadline) scope.controller.abort(scope.timeoutError);
  scope.controller.signal.throwIfAborted();
  if (scope.closed) throw Object.assign(Error("Hosted workflow execution has already finished"), { code: "HOSTED_RUN_CLOSED" });
}

/** One server-owned deadline across nested tools, engine work and output reads.
 * Await the engine's cancellation/settlement; never race the entire workflow
 * while its payment callbacks or nodes continue to mutate state. */
export async function withHostedRun(execute, timeoutMs = DEFAULT_HOSTED_RUN_MS) {
  const parent = context.getStore();
  if (parent) { assertOpen(parent); return execute(); }
  const duration = hostedRunTimeout(timeoutMs), controller = new AbortController();
  const label = duration >= 60_000 ? `${duration / 60_000} minute` : `${duration} ms`;
  const timeoutError = Object.assign(Error(`Workflow exceeded its ${label} hosted execution limit`), { code: "HOSTED_RUN_TIMEOUT" });
  const scope = { controller, closed: false, deadline: performance.now() + duration, timeoutError };
  const timer = setTimeout(() => controller.abort(timeoutError), duration);
  // A stopped server/worker must be able to exit after its sockets and poll
  // loop close. The deadline is not a replacement process-liveness handle.
  timer.unref?.();
  try {
    return await context.run(scope, async () => {
      assertOpen(scope); const result = await execute(); assertOpen(scope); return result;
    });
  } finally {
    scope.closed = true; clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort(Object.assign(Error("Hosted workflow execution has already finished"), { code: "HOSTED_RUN_CLOSED" }));
  }
}

export function hostedRunOptions(options = {}) {
  const scope = context.getStore();
  if (!scope) return options;
  assertOpen(scope);
  const signal = options.signal ? AbortSignal.any([options.signal, scope.controller.signal]) : scope.controller.signal;
  return { ...options, signal };
}

// Bound the I/O await even for an adapter that ignores AbortSignal. Its eventual
// completion cannot resume the cancelled engine or start another HTTP request.
function abortable(work, signal) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, value) => { if (done) return; done = true; signal.removeEventListener("abort", abort); fn(value); };
    const abort = () => finish(reject, signal.reason);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(work).then(value => finish(resolve, value), error => finish(reject, error));
  });
}

function boundedResponse(response, signal) {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        signal.throwIfAborted();
        const part = await abortable(reader.read(), signal);
        if (part.done) { reader.releaseLock(); controller.close(); }
        else controller.enqueue(part.value);
      } catch (error) {
        reader.cancel(error).catch(() => {}); controller.error(error);
      }
    },
    cancel(reason) { reader.cancel(reason).catch(() => {}); },
  });
  const result = new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  // Content URL resolution needs the real response origin, including redirects.
  const metadata = target => {
    for (const name of ["url", "redirected", "type"]) Object.defineProperty(target, name, { value: response[name], configurable: true });
    const clone = target.clone.bind(target);
    target.clone = () => metadata(clone());
    return target;
  };
  return metadata(result);
}

/** Runtime transport retains streaming and request signals. Outside a hosted
 * scope (stdio/pricing), it is the original fetch. */
export function hostedRunFetch(fetch = globalThis.fetch) {
  return async (input, init = {}) => {
    const scope = context.getStore();
    if (!scope) return fetch(input, init);
    assertOpen(scope);
    const outer = init.signal || (input instanceof Request ? input.signal : null);
    const signal = outer ? AbortSignal.any([outer, scope.controller.signal]) : scope.controller.signal;
    signal.throwIfAborted();
    const pending = Promise.resolve().then(() => { assertOpen(scope); signal.throwIfAborted(); return fetch(input, { ...init, signal }); });
    let response;
    try {
      response = await abortable(pending, signal);
      signal.throwIfAborted();
      return boundedResponse(response, signal);
    }
    catch (error) {
      if (signal.aborted) pending.then(res => res.body?.cancel()).catch(() => {});
      throw error;
    }
  };
}
