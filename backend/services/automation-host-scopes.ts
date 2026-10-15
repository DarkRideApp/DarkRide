/**
 * Host calls a script can make that reach beyond the device it is driving, and the scope its author must hold.
 * Keys are `<namespace>.<method>` as the sandbox dispatches them. Anything not listed is open.
 *
 * Outbound HTTP (`httpGet`, `httpPost`, `http.get` and the rest) is deliberately open: it is what an automation is for.
 */
export const GATED_HOST_CALLS: Readonly<Record<string, string>> = {
  'device.getCredentials': 'core.credentials:read',
  'device.setProxy': 'core.proxies:manage',
  'http.setProxy': 'core.proxies:manage',
};

export function requiredHostScope(target: string, method: string): string | undefined {
  const key = `${target}.${method}`;
  return Object.hasOwn(GATED_HOST_CALLS, key) ? GATED_HOST_CALLS[key] : undefined;
}
