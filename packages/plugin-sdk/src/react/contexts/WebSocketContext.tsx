// packages/plugin-sdk/src/react/contexts/WebSocketContext.tsx
import { createContext } from 'react';

export interface RestApiResponse {
  type: 'restapi';
  id: string;
  status: number;
  body: any;
}

export interface WebSocketContextValue {
  connected: boolean;
  serverReady: boolean;
  startupMessage: string;
  sendMessage: (action: string, data?: Record<string, any>) => void;
  sendRestApi: (method: string, path: string, body?: any) => Promise<RestApiResponse>;
  subscribe: (type: string, callback: (msg: any) => void) => () => void;
  subscribeBinary: (callback: (data: ArrayBuffer) => void) => () => void;
}

export const WebSocketContext = createContext<WebSocketContextValue | null>(null);
