import React, { useEffect, useState, useCallback } from 'react';
import { Modal } from '@darkrideapp/plugin-sdk/react';
import { ConfirmDialog } from '@darkrideapp/plugin-sdk/react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { useAuthOptional } from '@darkrideapp/plugin-sdk/react';

interface NotificationChannel {
  id: number;
  name: string;
  type: string;
  config: Record<string, any>;
  enabled: boolean;
  events: string[];
  createdAt: number;
}

interface QuietHoursConfig {
  enabled: boolean;
  startTime: string;
  endTime: string;
  timezone: string;
  daysOfWeek: number[];
}

interface HistoryEntry {
  id: number;
  channelName: string;
  eventType: string;
  title: string;
  body: string | null;
  success: boolean;
  error: string | null;
  createdAt: number;
}

const CHANNEL_TYPES = [
  { value: 'discord', label: 'Discord' },
  { value: 'slack', label: 'Slack' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'ntfy', label: 'ntfy' },
  { value: 'gotify', label: 'Gotify' },
  { value: 'email', label: 'Email (SMTP)' },
  { value: 'webhook', label: 'Generic Webhook' },
] as const;


type ChannelType = typeof CHANNEL_TYPES[number]['value'];

const EMPTY_FORM = {
  name: '',
  type: 'discord' as ChannelType,
  config: {} as Record<string, string>,
  events: [] as string[],
  enabled: true,
};

export function NotificationSettings() {
  const ws = useWebSocket();
  const auth = useAuthOptional();
  const hasScope = auth?.hasScope ?? (() => true);
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editingChannel, setEditingChannel] = useState<NotificationChannel | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<{ id: number; ok: boolean; error?: string } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [quietHours, setQuietHours] = useState<QuietHoursConfig>({
    enabled: false, startTime: '22:00', endTime: '08:00',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
  });
  const [quietHoursSaving, setQuietHoursSaving] = useState(false);
  const [quietHoursSaved, setQuietHoursSaved] = useState(false);
  const [criticalEvents, setCriticalEvents] = useState<string[]>([]);
  const [queuedCount, setQueuedCount] = useState(0);
  const [deleteConfirm, setDeleteConfirm] = useState<NotificationChannel | null>(null);
  const [eventTypes, setEventTypes] = useState<{ value: string; label: string; description: string }[]>([]);

  const fetchChannels = useCallback(async () => {
    const res = await ws.sendRestApi('GET', '/v1/notifications/channels');
    if (res?.body?.success) setChannels(res.body.data);
  }, [ws]);

  const fetchHistory = useCallback(async () => {
    const res = await ws.sendRestApi('GET', '/v1/notifications/history?limit=30');
    if (res?.body?.success) setHistory(res.body.data);
  }, [ws]);

  useEffect(() => { if (hasScope('core.settings:write')) fetchChannels(); }, [fetchChannels]);

  // Fetch event types from backend (core + plugin)
  useEffect(() => {
    if (!hasScope('core.settings:write')) return;
    ws.sendRestApi('GET', '/v1/notifications/event-types')
      .then((res: any) => {
        if (res.body?.success && Array.isArray(res.body.data)) {
          setEventTypes(res.body.data.map((e: any) => ({
            value: e.type,
            label: e.label || e.type,
            description: e.description || '',
          })));
        }
      })
      .catch(() => {});
  }, [ws]);

  // Load quiet hours config
  useEffect(() => {
    if (!hasScope('core.settings:write')) return;
    ws.sendRestApi('GET', '/v1/notifications/quiet-hours').then(res => {
      if (res?.body?.success) {
        setQuietHours(res.body.data);
        if (res.body.criticalEventTypes) setCriticalEvents(res.body.criticalEventTypes);
        if (typeof res.body.queuedCount === 'number') setQueuedCount(res.body.queuedCount);
      }
    }).catch(() => {});
  }, [ws]);

  // Queued notifications (the list rendered in the panel below the
  // Quiet Hours card). Refetched whenever the count changes or the user
  // takes an action that mutates the queue.
  const [queuedItems, setQueuedItems] = useState<Array<{
    id: number;
    eventType: string;
    createdAt: number;
    payload: { title?: string; body?: string; sourceType?: string; sourceId?: string | number } | null;
  }>>([]);

  // NOTE: `hasScope` is intentionally NOT in the dep array — `useAuthOptional`
  // returns a NEW `hasScope` function on every render (its fallback is
  // `?? (() => true)`), so including it would invalidate the useCallback
  // every render → the effect below would re-run every render → setQueuedItems
  // → re-render → infinite loop. Doing the scope check inline at call time
  // is fine because scopes don't change without a full auth reload.
  const fetchQueuedItems = useCallback(async () => {
    if (!hasScope('core.settings:write')) return;
    const res = await ws.sendRestApi('GET', '/v1/notifications/queue');
    if (res?.body?.success) setQueuedItems(res.body.data || []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  useEffect(() => {
    if (queuedCount > 0) fetchQueuedItems();
    else setQueuedItems([]);
  }, [queuedCount, fetchQueuedItems]);

  const handleSendOneQueued = useCallback(async (id: number) => {
    const res = await ws.sendRestApi('POST', `/v1/notifications/queue/${id}/send`);
    if (res?.body?.success) {
      setQueuedItems(items => items.filter(i => i.id !== id));
      setQueuedCount(c => Math.max(0, c - 1));
    }
  }, [ws]);

  const handleDiscardOneQueued = useCallback(async (id: number) => {
    const res = await ws.sendRestApi('DELETE', `/v1/notifications/queue/${id}`);
    if (res?.body?.success) {
      setQueuedItems(items => items.filter(i => i.id !== id));
      setQueuedCount(c => Math.max(0, c - 1));
    }
  }, [ws]);

  const handleSendAllQueued = useCallback(async () => {
    const res = await ws.sendRestApi('POST', '/v1/notifications/queue/flush');
    if (res?.body?.success) {
      setQueuedItems([]);
      setQueuedCount(0);
    }
  }, [ws]);

  const saveQuietHours = async () => {
    setQuietHoursSaving(true);
    try {
      await ws.sendRestApi('PUT', '/v1/notifications/quiet-hours', quietHours);
      setQuietHoursSaved(true);
      setTimeout(() => setQuietHoursSaved(false), 2000);
    } finally {
      setQuietHoursSaving(false);
    }
  };

  const toggleQuietHoursDay = (day: number) => {
    setQuietHours(qh => ({
      ...qh,
      daysOfWeek: qh.daysOfWeek.includes(day)
        ? qh.daysOfWeek.filter(d => d !== day)
        : [...qh.daysOfWeek, day].sort(),
    }));
  };

  const openNew = () => {
    setEditingChannel(null);
    setForm(EMPTY_FORM);
    setShowModal(true);
  };

  const openEdit = (ch: NotificationChannel) => {
    setEditingChannel(ch);
    setForm({
      name: ch.name,
      type: ch.type as ChannelType,
      config: ch.config as Record<string, string>,
      events: [...ch.events],
      enabled: ch.enabled,
    });
    setShowModal(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (editingChannel) {
        await ws.sendRestApi('PUT', `/v1/notifications/channels/${editingChannel.id}`, {
          name: form.name,
          type: form.type,
          config: form.config,
          events: form.events,
          enabled: form.enabled,
        });
      } else {
        await ws.sendRestApi('POST', '/v1/notifications/channels', {
          name: form.name,
          type: form.type,
          config: form.config,
          events: form.events,
          enabled: form.enabled,
        });
      }
      setShowModal(false);
      fetchChannels();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    await ws.sendRestApi('DELETE', `/v1/notifications/channels/${id}`);
    fetchChannels();
  };

  const handleToggle = async (ch: NotificationChannel) => {
    await ws.sendRestApi('PUT', `/v1/notifications/channels/${ch.id}`, { enabled: !ch.enabled });
    fetchChannels();
  };

  const handleTest = async (id: number) => {
    setTesting(id);
    setTestResult(null);
    try {
      const res = await ws.sendRestApi('POST', `/v1/notifications/channels/${id}/test`);
      setTestResult({ id, ok: res?.body?.success ?? false, error: res?.body?.error });
    } catch {
      setTestResult({ id, ok: false, error: 'Request failed' });
    } finally {
      setTesting(null);
    }
  };

  const toggleEvent = (eventType: string) => {
    setForm(f => ({
      ...f,
      events: f.events.includes(eventType)
        ? f.events.filter(e => e !== eventType)
        : [...f.events, eventType],
    }));
  };

  const updateConfig = (key: string, value: string) => {
    setForm(f => ({ ...f, config: { ...f.config, [key]: value } }));
  };

  // Auto-fill helpers when switching channel type
  const handleTypeChange = (type: ChannelType) => {
    const config: Record<string, string> = {};
    if (type === 'ntfy') {
      config.url = 'https://ntfy.sh';
      config.topic = '';
    }
    setForm(f => ({ ...f, type, config }));
  };

  const renderConfigFields = () => {
    switch (form.type) {
      case 'discord':
        return (
          <div className="form-group">
            <label htmlFor="notif-webhook-url">Webhook URL</label>
            <input
              id="notif-webhook-url"
              className="form-input"
              value={form.config.url || ''}
              onChange={e => updateConfig('url', e.target.value)}
              placeholder="https://discord.com/api/webhooks/..."
              data-testid="notif-config-url"
            />
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Server Settings &gt; Integrations &gt; Webhooks &gt; New Webhook &gt; Copy URL
            </span>
          </div>
        );
      case 'slack':
        return (
          <div className="form-group">
            <label htmlFor="notif-slack-url">Incoming Webhook URL</label>
            <input
              id="notif-slack-url"
              className="form-input"
              value={form.config.url || ''}
              onChange={e => updateConfig('url', e.target.value)}
              placeholder="https://hooks.slack.com/services/..."
              data-testid="notif-config-url"
            />
          </div>
        );
      case 'telegram':
        return (
          <>
            <div className="form-group">
              <label htmlFor="notif-telegram-token">Bot Token</label>
              <input
                id="notif-telegram-token"
                className="form-input"
                value={form.config.botToken || ''}
                onChange={e => updateConfig('botToken', e.target.value)}
                placeholder="123456:ABC-DEF..."
                data-testid="notif-config-bot-token"
              />
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Get from @BotFather on Telegram
              </span>
            </div>
            <div className="form-group">
              <label htmlFor="notif-telegram-chat-id">Chat ID</label>
              <input
                id="notif-telegram-chat-id"
                className="form-input"
                value={form.config.chatId || ''}
                onChange={e => updateConfig('chatId', e.target.value)}
                placeholder="-1001234567890"
                data-testid="notif-config-chat-id"
              />
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Send a message to your bot, then visit https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates
              </span>
            </div>
          </>
        );
      case 'ntfy':
        return (
          <>
            <div className="form-group">
              <label htmlFor="notif-ntfy-url">Server URL</label>
              <input
                id="notif-ntfy-url"
                className="form-input"
                value={form.config.url || 'https://ntfy.sh'}
                onChange={e => updateConfig('url', e.target.value)}
                placeholder="https://ntfy.sh"
                data-testid="notif-config-url"
              />
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Default: https://ntfy.sh (free public server), or your self-hosted instance
              </span>
            </div>
            <div className="form-group">
              <label htmlFor="notif-ntfy-topic">Topic</label>
              <input
                id="notif-ntfy-topic"
                className="form-input"
                value={form.config.topic || ''}
                onChange={e => updateConfig('topic', e.target.value)}
                placeholder="darkride-alerts"
                data-testid="notif-config-topic"
              />
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Subscribe to this topic in the ntfy app on your phone
              </span>
            </div>
          </>
        );
      case 'gotify':
        return (
          <>
            <div className="form-group">
              <label htmlFor="notif-gotify-url">Server URL</label>
              <input
                id="notif-gotify-url"
                className="form-input"
                value={form.config.url || ''}
                onChange={e => updateConfig('url', e.target.value)}
                placeholder="https://gotify.example.com"
                data-testid="notif-config-url"
              />
            </div>
            <div className="form-group">
              <label htmlFor="notif-gotify-token">App Token</label>
              <input
                id="notif-gotify-token"
                className="form-input"
                value={form.config.appToken || ''}
                onChange={e => updateConfig('appToken', e.target.value)}
                placeholder="A..."
                data-testid="notif-config-app-token"
              />
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Create an application in Gotify and copy its token
              </span>
            </div>
          </>
        );
      case 'email':
        return (
          <>
            <div className="form-group">
              <label htmlFor="notif-smtp-host">SMTP Host</label>
              <input
                id="notif-smtp-host"
                className="form-input"
                value={form.config.smtpHost || ''}
                onChange={e => updateConfig('smtpHost', e.target.value)}
                placeholder="smtp.gmail.com"
                data-testid="notif-config-smtp-host"
              />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <div className="form-group" style={{ flex: 1 }}>
                <label htmlFor="notif-smtp-port">Port</label>
                <input
                  id="notif-smtp-port"
                  className="form-input"
                  value={form.config.smtpPort || ''}
                  onChange={e => updateConfig('smtpPort', e.target.value)}
                  placeholder="587"
                  data-testid="notif-config-smtp-port"
                />
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label htmlFor="notif-smtp-security">Security</label>
                <select
                  id="notif-smtp-security"
                  className="form-input"
                  value={form.config.smtpSecure || 'false'}
                  onChange={e => updateConfig('smtpSecure', e.target.value)}
                  data-testid="notif-config-smtp-secure"
                >
                  <option value="false">STARTTLS (port 587)</option>
                  <option value="true">TLS (port 465)</option>
                </select>
              </div>
            </div>
            <div className="form-group">
              <label htmlFor="notif-smtp-username">Username</label>
              <input
                id="notif-smtp-username"
                className="form-input"
                value={form.config.smtpUser || ''}
                onChange={e => updateConfig('smtpUser', e.target.value)}
                placeholder="user@example.com"
                data-testid="notif-config-smtp-user"
              />
            </div>
            <div className="form-group">
              <label htmlFor="notif-smtp-password">Password</label>
              <input
                id="notif-smtp-password"
                className="form-input"
                type="password"
                value={form.config.smtpPass || ''}
                onChange={e => updateConfig('smtpPass', e.target.value)}
                placeholder="App password or SMTP password"
                data-testid="notif-config-smtp-pass"
              />
            </div>
            <div className="form-group">
              <label htmlFor="notif-smtp-from">From Address</label>
              <input
                id="notif-smtp-from"
                className="form-input"
                value={form.config.fromAddress || ''}
                onChange={e => updateConfig('fromAddress', e.target.value)}
                placeholder="darkride@example.com"
                data-testid="notif-config-from-address"
              />
            </div>
            <div className="form-group">
              <label htmlFor="notif-smtp-to">To Addresses</label>
              <input
                id="notif-smtp-to"
                className="form-input"
                value={form.config.toAddresses || ''}
                onChange={e => updateConfig('toAddresses', e.target.value)}
                placeholder="admin@example.com, team@example.com"
                data-testid="notif-config-to-addresses"
              />
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Comma-separated list of recipient email addresses
              </span>
            </div>
          </>
        );
      case 'webhook':
        return (
          <>
            <div className="form-group">
              <label htmlFor="notif-custom-url">Webhook URL</label>
              <input
                id="notif-custom-url"
                className="form-input"
                value={form.config.url || ''}
                onChange={e => updateConfig('url', e.target.value)}
                placeholder="https://example.com/webhook"
                data-testid="notif-config-url"
              />
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Receives POST with JSON body: {'{'} eventType, title, body, sourceType, sourceId, timestamp {'}'}
              </span>
            </div>
          </>
        );
    }
  };

  return (
    <div>
      <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12, color: 'var(--text-primary)' }}>
        Notifications
      </h2>

      {/* Quiet Hours */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ marginBottom: 12 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
            Quiet Hours
            <span style={{
              fontSize: 11, fontWeight: 500, padding: '1px 8px', borderRadius: 10,
              background: quietHours.enabled ? 'rgba(99,102,241,0.12)' : 'rgba(107,114,128,0.1)',
              color: quietHours.enabled ? '#6366f1' : 'var(--text-muted)',
            }}>
              {quietHours.enabled ? 'Active' : 'Off'}
            </span>
            {queuedCount > 0 && (
              <span style={{
                fontSize: 11, fontWeight: 500, padding: '1px 8px', borderRadius: 10,
                background: 'rgba(234,179,8,0.12)', color: '#eab308',
              }}>
                {queuedCount} queued
              </span>
            )}
          </h3>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: 0, lineHeight: 1.5 }}>
            Non-critical notifications are queued during quiet hours and sent when the window ends. Critical events
            ({criticalEvents.length > 0 ? criticalEvents.join(', ') : 'failures, disconnections, errors'}) always get through.
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={quietHours.enabled}
              onChange={e => setQuietHours(qh => ({ ...qh, enabled: e.target.checked }))}
              data-testid="quiet-hours-enabled"
            />
            <span style={{ fontWeight: 500 }}>Enable quiet hours</span>
          </label>

          {quietHours.enabled && (
            <>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
                <div className="form-group" style={{ margin: 0 }}>
                  <label style={{ fontSize: 12 }}>Start</label>
                  <input
                    type="time"
                    className="form-input"
                    value={quietHours.startTime}
                    onChange={e => setQuietHours(qh => ({ ...qh, startTime: e.target.value }))}
                    data-testid="quiet-hours-start"
                  />
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label style={{ fontSize: 12 }}>End</label>
                  <input
                    type="time"
                    className="form-input"
                    value={quietHours.endTime}
                    onChange={e => setQuietHours(qh => ({ ...qh, endTime: e.target.value }))}
                    data-testid="quiet-hours-end"
                  />
                </div>
                <div className="form-group" style={{ margin: 0, flex: 1 }}>
                  <label style={{ fontSize: 12 }}>Timezone</label>
                  <select
                    className="form-select"
                    value={quietHours.timezone}
                    onChange={e => setQuietHours(qh => ({ ...qh, timezone: e.target.value }))}
                    data-testid="quiet-hours-timezone"
                  >
                    {(typeof Intl.supportedValuesOf === 'function'
                      ? Intl.supportedValuesOf('timeZone')
                      : [quietHours.timezone]
                    ).map(tz => (
                      <option key={tz} value={tz}>{tz.replace(/_/g, ' ')}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="form-group" style={{ margin: 0 }}>
                <label style={{ fontSize: 12 }}>Active days</label>
                <div style={{ display: 'flex', gap: 4 }}>
                  {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label, idx) => (
                    <button
                      key={idx}
                      className="btn btn-sm"
                      onClick={() => toggleQuietHoursDay(idx)}
                      style={{
                        minWidth: 40,
                        background: quietHours.daysOfWeek.includes(idx)
                          ? 'rgba(99,102,241,0.15)' : undefined,
                        color: quietHours.daysOfWeek.includes(idx)
                          ? '#6366f1' : 'var(--text-muted)',
                        fontWeight: quietHours.daysOfWeek.includes(idx) ? 600 : 400,
                      }}
                      data-testid={`quiet-hours-day-${idx}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          <div>
            <button
              className="btn btn-primary btn-sm"
              onClick={saveQuietHours}
              disabled={quietHoursSaving}
              data-testid="quiet-hours-save"
            >
              {quietHoursSaving ? 'Saving...' : quietHoursSaved ? 'Saved' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      {/* Queue panel: only rendered when there's something queued. Lets the
          user inspect what's waiting, send individual notifications now
          (override quiet hours for that one event), discard them without
          sending, or flush the whole queue. */}
      {queuedItems.length > 0 && (
        <div
          className="card"
          style={{ marginBottom: 20 }}
          data-testid="queued-notifications-panel"
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 12 }}>
            <div>
              <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
                Queued ({queuedItems.length})
              </h3>
              <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: 0, lineHeight: 1.5 }}>
                Non-critical notifications waiting for the quiet-hours window to end. Send or discard them individually, or flush all now.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={handleSendAllQueued}
              data-testid="queued-send-all"
            >
              Send all now
            </button>
          </div>

          <ul
            style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}
          >
            {queuedItems.map(item => {
              const title = item.payload?.title || item.eventType;
              const body = item.payload?.body || '';
              const when = new Date(item.createdAt).toLocaleString();
              return (
                <li
                  key={item.id}
                  data-testid={`queued-item-${item.id}`}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    gap: 12,
                    padding: '8px 10px',
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 6,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{title}</div>
                    {body && (
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {body}
                      </div>
                    )}
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                      {item.eventType} · queued {when}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => handleSendOneQueued(item.id)}
                      data-testid={`queued-send-${item.id}`}
                    >
                      Send now
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => handleDiscardOneQueued(item.id)}
                      data-testid={`queued-discard-${item.id}`}
                    >
                      Discard
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div id="section-notifications" className="card" style={{ marginBottom: 20 }}>
        <div style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
            Notification Channels
            <span style={{
              fontSize: 11, fontWeight: 500, padding: '1px 8px', borderRadius: 10,
              background: channels.filter(c => c.enabled).length > 0 ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.1)',
              color: channels.filter(c => c.enabled).length > 0 ? 'var(--status-online, #22c55e)' : 'var(--text-muted)',
            }}>
              {channels.filter(c => c.enabled).length > 0
                ? `${channels.filter(c => c.enabled).length} active`
                : 'None configured'}
            </span>
          </h3>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: 0, lineHeight: 1.5 }}>
            Receive push notifications when events occur. Each channel can subscribe to different event types.
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button className="btn btn-sm btn-primary" onClick={openNew} data-testid="add-channel-btn">
            Add Channel
          </button>
          <button
            className="btn btn-sm"
            onClick={() => { setShowHistory(true); fetchHistory(); }}
            data-testid="notif-history-btn"
          >
            History
          </button>
        </div>

        {channels.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '8px 0' }}>
            No notification channels configured.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {channels.map(ch => (
              <div
                key={ch.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                  borderRadius: 6, background: 'var(--card-bg)',
                  border: '1px solid var(--border-color)',
                  opacity: ch.enabled ? 1 : 0.5,
                }}
              >
                <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)', minWidth: 60 }}>
                  {ch.type}
                </span>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{ch.name}</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {ch.events.length} event{ch.events.length !== 1 ? 's' : ''}
                </span>
                <button
                  className="btn btn-sm"
                  onClick={() => handleTest(ch.id)}
                  disabled={testing === ch.id}
                  data-testid={`test-channel-${ch.id}`}
                >
                  {testing === ch.id ? 'Sending...' : testResult?.id === ch.id ? (testResult.ok ? 'Sent' : 'Failed') : 'Test'}
                </button>
                {testResult?.id === ch.id && !testResult.ok && testResult.error && (
                  <span style={{ fontSize: 11, color: 'var(--status-error, #ef4444)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={testResult.error}>
                    {testResult.error}
                  </span>
                )}
                <button className="btn btn-sm" onClick={() => handleToggle(ch)} data-testid={`toggle-channel-${ch.id}`}>
                  {ch.enabled ? 'Disable' : 'Enable'}
                </button>
                <button className="btn btn-sm" onClick={() => openEdit(ch)} data-testid={`edit-channel-${ch.id}`}>
                  Edit
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => setDeleteConfirm(ch)}
                  style={{ color: 'var(--status-error, #ef4444)' }}
                  data-testid={`delete-channel-${ch.id}`}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add/Edit Channel Modal */}
      {showModal && (
        <Modal
          title={editingChannel ? `Edit Channel: ${editingChannel.name}` : 'Add Notification Channel'}
          onClose={() => setShowModal(false)}
          footer={
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={() => setShowModal(false)}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={handleSave}
                disabled={saving || !form.name || form.events.length === 0}
                data-testid="save-channel-btn"
              >
                {saving ? 'Saving...' : editingChannel ? 'Update' : 'Create'}
              </button>
            </div>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="form-group">
              <label htmlFor="notif-channel-name">Channel Name</label>
              <input
                id="notif-channel-name"
                className="form-input"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. My Discord"
                data-testid="notif-name-input"
              />
            </div>

            <div className="form-group">
              <label htmlFor="notif-channel-type">Type</label>
              <select
                id="notif-channel-type"
                className="form-input"
                value={form.type}
                onChange={e => handleTypeChange(e.target.value as ChannelType)}
                data-testid="notif-type-select"
              >
                {CHANNEL_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>

            {renderConfigFields()}

            <div className="form-group">
              <label>Events to notify on</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {eventTypes.map(evt => (
                  <label
                    key={evt.value}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}
                  >
                    <input
                      type="checkbox"
                      checked={form.events.includes(evt.value)}
                      onChange={() => toggleEvent(evt.value)}
                    />
                    <span style={{ fontWeight: 500 }}>{evt.label}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {evt.description}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* History Modal */}
      {showHistory && (
        <Modal
          title="Notification History"
          onClose={() => setShowHistory(false)}
          width={700}
        >
          {history.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: 16 }}>
              No notifications sent yet.
            </div>
          ) : (
            <div style={{ maxHeight: 400, overflow: 'auto' }}>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left' }}>
                    <th style={{ padding: '6px 8px' }}>Time</th>
                    <th style={{ padding: '6px 8px' }}>Channel</th>
                    <th style={{ padding: '6px 8px' }}>Event</th>
                    <th style={{ padding: '6px 8px' }}>Title</th>
                    <th style={{ padding: '6px 8px' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map(h => (
                    <tr key={h.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                      <td style={{ padding: '6px 8px', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                        {new Date(typeof h.createdAt === 'number' ? h.createdAt * 1000 : h.createdAt).toLocaleString()}
                      </td>
                      <td style={{ padding: '6px 8px' }}>{h.channelName}</td>
                      <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontSize: 11 }}>{h.eventType}</td>
                      <td style={{ padding: '6px 8px', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {h.title}
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        <span style={{
                          fontSize: 10, fontWeight: 500, padding: '1px 6px', borderRadius: 8,
                          background: h.success ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.1)',
                          color: h.success ? 'var(--status-online, #22c55e)' : 'var(--status-error, #ef4444)',
                        }}>
                          {h.success ? 'Sent' : 'Failed'}
                        </span>
                        {h.error && (
                          <span style={{ fontSize: 10, color: 'var(--status-error)', marginLeft: 4 }} title={h.error}>
                            {h.error.substring(0, 40)}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}

      {deleteConfirm && (
        <ConfirmDialog
          title="Delete Notification Channel"
          message={`Are you sure you want to delete the notification channel "${deleteConfirm.name}"? This action cannot be undone.`}
          onConfirm={() => { handleDelete(deleteConfirm.id); setDeleteConfirm(null); }}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}
    </div>
  );
}
