/**
 * Signed-in API sessions for the specs that check what a script may do with its author's scopes.
 */

import { expect, type APIRequestContext, type Browser } from '@playwright/test';
import {
  API_BASE,
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  apiLogin,
  createLimitedUser,
  claimUser,
} from './auth';

export const WRITER_SCOPES = ['core.automations:read', 'core.automations:edit', 'core.automations:execute'];

export interface Session { request: APIRequestContext; csrf: string }

export async function signInAdmin(browser: Browser): Promise<Session> {
  const request = (await browser.newContext()).request;
  return { request, csrf: await apiLogin(request, ADMIN_USERNAME, ADMIN_PASSWORD) };
}

/** A user who can edit and run automations but holds none of the scopes a script's gated calls need. */
export async function signInWriter(browser: Browser, adminSession: Session, scopes: string[] = WRITER_SCOPES): Promise<Session> {
  const username = `script-writer-${Date.now()}`;
  const password = 'script-writer-pw-789';
  const claimToken = await createLimitedUser(adminSession.request, adminSession.csrf, username, scopes);
  const request = (await browser.newContext()).request;
  return { request, csrf: await claimUser(request, claimToken, password) };
}

export async function send(s: Session, method: 'post' | 'put' | 'delete', path: string, data?: unknown) {
  const res = await s.request[method](`${API_BASE}${path}`, { data, headers: { 'X-CSRF-Token': s.csrf } });
  return { status: res.status(), body: await res.json() };
}

export async function runScript(s: Session, id: number) {
  const res = await send(s, 'post', `/v1/automation/run/${id}`, {});
  expect(res.status).toBe(200);
  return res.body.data as { success: boolean; error?: string };
}

/** The runner gets its tool registry late in startup, right after the tool list route shows the tool. */
export async function waitForTool(s: Session, name: string) {
  await expect.poll(async () => {
    const res = await s.request.get(`${API_BASE}/v1/tools`);
    return res.ok() && JSON.stringify(await res.json()).includes(name);
  }, { timeout: 90_000, intervals: [500, 1000, 2000] }).toBe(true);
}
