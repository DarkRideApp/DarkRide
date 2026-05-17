export interface PluginNotificationEvent {
  type: string;
  label: string;
  description?: string;
  critical?: boolean;
}

/**
 * Payload emitted via `ctx.notify()`. Mirrors the core's `NotificationEvent`
 * shape (declared in `backend/services/notification-service.ts`); duplicated
 * here so plugin-context types don't import from `backend/`.
 */
export interface PluginNotifyEvent {
  type: string;
  title: string;
  body: string;
  sourceType?: string;
  sourceId?: string;
  /** Deep link path within the UI, e.g. /ui/automations/session/42 */
  url?: string;
}
