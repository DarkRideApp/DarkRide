export interface PluginApiEndpointOpts {
  /** Required scopes — request rejected with 403 if user lacks any. */
  requires?: string[];
}

/**
 * Per-plugin HTTP API object passed to ctx.api(setup). Mirrors the Express
 * router method API (get/post/put/delete/patch) but registers each endpoint
 * in BOTH the Express router and the WebSocket-REST routing table, so plugin
 * endpoints are reachable via either transport.
 */
export interface PluginApi {
  get(path: string, handler: (req: any, res: any) => void | Promise<void>, opts?: PluginApiEndpointOpts): void;
  post(path: string, handler: (req: any, res: any) => void | Promise<void>, opts?: PluginApiEndpointOpts): void;
  put(path: string, handler: (req: any, res: any) => void | Promise<void>, opts?: PluginApiEndpointOpts): void;
  delete(path: string, handler: (req: any, res: any) => void | Promise<void>, opts?: PluginApiEndpointOpts): void;
  patch(path: string, handler: (req: any, res: any) => void | Promise<void>, opts?: PluginApiEndpointOpts): void;
}
