export interface SchemaField { field: string; type: string; description: string }

export interface HookBus {
  /**
   * `schema`/`description` are optional and `schema` may be the pre-existing
   * `Record<string, string>` shape — kept for compatibility with plugins already built
   * against an older @darkrideapp/plugin-sdk. New code should pass `SchemaField[]` and a
   * real description; the richer shape is what the AI Job Pipelines editor's typed-event
   * picker reads.
   */
  define(name: string, schema?: SchemaField[] | Record<string, string>, description?: string): void;
  on(name: string, handler: (...args: any[]) => void | Promise<void>): void;
  off(name: string, handler: (...args: any[]) => void | Promise<void>): void;
  emit(name: string, ...args: any[]): void;
}
