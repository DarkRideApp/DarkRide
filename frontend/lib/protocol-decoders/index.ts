import type { ProtocolDecoder } from '@darkrideapp/plugin-sdk/react';
import { pluginRegistry } from '@darkrideapp/plugin-sdk/react';

export type { ProtocolDecoder, RawFrame, DecodedMessage } from '@darkrideapp/plugin-sdk/react';

export function detectProtocol(headersJson: string | null): ProtocolDecoder | null {
  if (!headersJson) return null;
  let headers: Record<string, string>;
  try {
    headers = JSON.parse(headersJson);
  } catch {
    return null;
  }

  const allDecoders = pluginRegistry.getDecoders();
  for (const decoder of allDecoders) {
    if (decoder.detect(headers)) return decoder;
  }
  return null;
}
