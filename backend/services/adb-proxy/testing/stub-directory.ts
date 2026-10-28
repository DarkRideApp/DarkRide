import type { DeviceDirectory } from '../device-directory';

export class StubDirectory implements DeviceDirectory {
  readonly online: Set<string>;
  private onlineFns: Array<(id: string) => void> = [];
  private offlineFns: Array<(id: string) => void> = [];

  constructor(ids: string[]) {
    this.online = new Set(ids);
  }

  listOnlineAndroid(): Array<{ id: string; name: string | null }> {
    return [...this.online].map((id) => ({ id, name: null }));
  }

  onOnline(fn: (id: string) => void): void {
    this.onlineFns.push(fn);
  }

  onOffline(fn: (id: string) => void): void {
    this.offlineFns.push(fn);
  }

  goOnline(id: string): void {
    this.online.add(id);
    for (const fn of this.onlineFns) fn(id);
  }

  goOffline(id: string): void {
    this.online.delete(id);
    for (const fn of this.offlineFns) fn(id);
  }
}
