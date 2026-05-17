import type { DeviceFrida, FridaMessage } from '../../shared/types/automation';

type CallBridgeFn = (method: string, params: Record<string, any>) => Promise<any>;
type LogCallFn = <T>(method: string, params: Record<string, any>, fn: () => Promise<T>) => Promise<T>;
type ScriptResolverFn = (name: string) => Promise<string | null>;

export class DeviceFridaImpl implements DeviceFrida {
  private sessionIds: number[] = [];
  private pids: number[] = [];
  private messageIndex = 0;
  private serverStarted = false;

  constructor(
    private callBridge: CallBridgeFn,
    private logCall: LogCallFn,
    private resolveScript: ScriptResolverFn,
  ) {}

  async run(bundleId: string, scripts: string | string[]): Promise<void> {
    const scriptNames = Array.isArray(scripts) ? scripts : [scripts];
    await this.logCall('frida.run', { bundleId, scripts: scriptNames }, async () => {
      if (!this.serverStarted) {
        await this.callBridge('frida_start_server', {});
        this.serverStarted = true;
      }
      const spawnResult = await this.callBridge('frida_spawn', { bundle_id: bundleId });
      this.sessionIds.push(spawnResult.session_id);
      this.pids.push(spawnResult.pid);
      for (const name of scriptNames) {
        const code = await this.resolveScript(name);
        if (!code) throw new Error(`Frida script not found: ${name}`);
        await this.callBridge('frida_load_script', { session_id: spawnResult.session_id, code });
      }
      await this.callBridge('frida_resume', { pid: spawnResult.pid });
    });
  }

  async inject(bundleId: string, code: string): Promise<void> {
    await this.logCall('frida.inject', { bundleId, codeLength: code.length }, async () => {
      if (!this.serverStarted) {
        await this.callBridge('frida_start_server', {});
        this.serverStarted = true;
      }
      const apps = await this.callBridge('frida_list_apps', {});
      const app = apps.find((a: any) => a.identifier === bundleId && a.pid);
      if (!app) throw new Error(`App ${bundleId} is not running`);
      const attachResult = await this.callBridge('frida_attach', { pid: app.pid });
      this.sessionIds.push(attachResult.session_id);
      await this.callBridge('frida_load_script', { session_id: attachResult.session_id, code });
    });
  }

  async loadScript(name: string): Promise<void> {
    await this.logCall('frida.loadScript', { name }, async () => {
      const code = await this.resolveScript(name);
      if (!code) throw new Error(`Frida script not found: ${name}`);
      if (this.sessionIds.length === 0) {
        throw new Error('No active Frida session. Call frida.run() or frida.inject() first.');
      }
      const sessionId = this.sessionIds[this.sessionIds.length - 1];
      await this.callBridge('frida_load_script', { session_id: sessionId, code });
    });
  }

  async getMessages(): Promise<FridaMessage[]> {
    const result = await this.callBridge('frida_get_messages', { since: this.messageIndex });
    this.messageIndex = result.next_index;
    return result.messages;
  }

  async send(message: any): Promise<void> {
    await this.logCall('frida.send', { message }, async () => {
      for (const sid of this.sessionIds) {
        await this.callBridge('frida_send_message', { script_id: sid, message });
      }
    });
  }

  async stop(): Promise<void> {
    await this.logCall('frida.stop', {}, async () => {
      for (const sessionId of this.sessionIds) {
        try { await this.callBridge('frida_detach', { session_id: sessionId }); }
        catch { /* best effort */ }
      }
      this.sessionIds = [];
      this.pids = [];
      if (this.serverStarted) {
        await this.callBridge('frida_stop_server', {});
        this.serverStarted = false;
      }
    });
  }

  async cleanup(): Promise<void> {
    try { await this.stop(); } catch { /* ignore */ }
  }
}

export class NoopDeviceFrida implements DeviceFrida {
  async run(): Promise<void> { throw new Error('Frida is not available'); }
  async inject(): Promise<void> { throw new Error('Frida is not available'); }
  async loadScript(): Promise<void> { throw new Error('Frida is not available'); }
  async getMessages(): Promise<FridaMessage[]> { return []; }
  async send(): Promise<void> { throw new Error('Frida is not available'); }
  async stop(): Promise<void> { /* noop */ }
}
