import net from 'node:net';

// Below the default Linux ephemeral range (32768 and up), so an outgoing connection cannot be handed a port in the run.
const RANGE_LOW = 20000;
const RANGE_SPAN = 10000;

async function bindable(port: number): Promise<boolean> {
  const probe = net.createServer();
  const free = await new Promise<boolean>((resolve) => {
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => resolve(true));
  });
  if (free) await new Promise<void>((resolve) => probe.close(() => resolve()));
  return free;
}

/** The first of `count` consecutive TCP ports that were all free a moment ago; callers use it as the start of a small range. */
export async function freePortBase(count = 16): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const base = RANGE_LOW + Math.floor(Math.random() * RANGE_SPAN);
    let allFree = true;
    for (let offset = 0; offset < count && allFree; offset++) allFree = await bindable(base + offset);
    if (allFree) return base;
  }
  throw new Error('no free port range found');
}
