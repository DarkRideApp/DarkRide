/// <reference lib="webworker" />
import { createStreamWorkerCore } from './stream-worker-core';
import type { WorkerInMsg, WorkerOutMsg } from './stream-worker-protocol';

// Thin worker entry: wire the pure core to worker globals. All logic lives in
// createStreamWorkerCore (unit tested); this file only exists to run in the
// Worker realm, so it is intentionally untestable in jsdom.
const ctx = self as unknown as DedicatedWorkerGlobalScope;
const core = createStreamWorkerCore((msg: WorkerOutMsg) => ctx.postMessage(msg));
ctx.onmessage = (e: MessageEvent<WorkerInMsg>) => core.handle(e.data);
