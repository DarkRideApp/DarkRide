/**
 * Writes the interactive-intercept armed config to a JSON file that the
 * mitmproxy addon reloads by mtime (same pattern as intercept-config-writer).
 *
 * The addon reads this file on every request/response to decide — locally, with
 * no round-trip — whether interception is armed and the flow matches. Only when
 * it does does the addon make the blocking POST /v1/intercept/hold call. Keeping
 * the decision addon-local means the hot path stays free when disarmed.
 */

import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import type { InterceptArmedConfig } from '../../shared/types/websocket';

export function getInterceptHoldConfigPath(): string {
  return path.resolve('./data/intercept-hold-config.json');
}

export function writeHoldConfig(config: InterceptArmedConfig): string {
  const filePath = getInterceptHoldConfigPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(config));
  return filePath;
}
