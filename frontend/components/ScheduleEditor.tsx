import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { Clock, Calendar, Repeat, Terminal, Save, RotateCcw, Timer } from 'lucide-react';

export type ScheduleMode = 'interval' | 'daily' | 'cron' | 'windowed';

export interface ScheduleValue {
  mode: ScheduleMode;
  intervalMinutes: number;
  dailyHour: number;
  dailyMinute: number;
  cron: string;
  windowStart: string; // "HH:MM"
  windowEnd: string;   // "HH:MM"
  windowIntervalMinutes: number;
}

interface ScheduleEditorProps {
  value: string;
  defaultValue?: string;
  /** Called with cron string when user clicks Save (job-style). */
  onSave?: (schedule: string) => void;
  onCancel?: () => void;
  saving?: boolean;
  /** Called on every change with structured value (automation-style). */
  onChange?: (value: ScheduleValue, cronString: string) => void;
  /** Which modes to show. Default: all except windowed. */
  modes?: ScheduleMode[];
  /** If true, hide the save/cancel/reset footer. */
  inline?: boolean;
  /** Compact layout for narrow panels (< 320px). */
  compact?: boolean;
}

// --- Cron parser ---

function matchField(field: string, value: number): boolean {
  for (const part of field.split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? parseInt(stepStr) : 1;
    if (range === '*') {
      if (value % step === 0) return true;
      continue;
    }
    const rangeMatch = range.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const lo = parseInt(rangeMatch[1]);
      const hi = parseInt(rangeMatch[2]);
      if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
      continue;
    }
    if (parseInt(range) === value) return true;
  }
  return false;
}

function matchesCron(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minF, hourF, domF, monF, dowF] = parts;
  return matchField(minF, date.getMinutes())
    && matchField(hourF, date.getHours())
    && matchField(domF, date.getDate())
    && matchField(monF, date.getMonth() + 1)
    && matchField(dowF, date.getDay());
}

export function isCronValid(cron: string): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every(p => /^[\d*\/,-]+$/.test(p));
}

export function getNextCronRuns(cron: string, count: number): Date[] {
  if (!isCronValid(cron)) return [];
  const results: Date[] = [];
  const check = new Date();
  check.setSeconds(0, 0);
  check.setMinutes(check.getMinutes() + 1);

  for (let i = 0; i < 60 * 24 * 7 && results.length < count; i++) {
    if (matchesCron(cron, check)) {
      results.push(new Date(check));
    }
    check.setMinutes(check.getMinutes() + 1);
  }
  return results;
}

function formatDateTime(d: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${days[d.getDay()]} ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

// --- Parse existing schedule ---

export function parseSchedule(schedule: string): ScheduleValue {
  const defaults: ScheduleValue = {
    mode: 'cron', intervalMinutes: 30, dailyHour: 3, dailyMinute: 0,
    cron: '', windowStart: '23:30', windowEnd: '16:30', windowIntervalMinutes: 5,
  };

  // Windowed interval: "Every 5m 23:30-16:30"
  const windowedMatch = schedule.match(/every\s+(\d+)\s*m\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/i);
  if (windowedMatch) {
    return { ...defaults, mode: 'windowed', windowIntervalMinutes: parseInt(windowedMatch[1]), windowStart: windowedMatch[2], windowEnd: windowedMatch[3] };
  }

  // Interval: "Every N minutes/hours"
  const intervalMatch = schedule.match(/every\s+(\d+)\s*(m|h|min|minutes?|hours?|seconds?|sec|s)/i);
  if (intervalMatch) {
    const val = parseInt(intervalMatch[1]);
    const unit = intervalMatch[2].toLowerCase();
    return { ...defaults, mode: 'interval', intervalMinutes: unit.startsWith('h') ? val * 60 : val };
  }

  // Cron: 5 fields
  if (isCronValid(schedule)) {
    const parts = schedule.trim().split(/\s+/);
    // Simple daily: "M H * * *"
    if (parts[2] === '*' && parts[3] === '*' && parts[4] === '*' && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
      return { ...defaults, mode: 'daily', dailyHour: parseInt(parts[1]), dailyMinute: parseInt(parts[0]), cron: schedule.trim() };
    }
    // Simple interval: "*/N * * * *"
    const stepMatch = parts[0].match(/^\*\/(\d+)$/);
    if (stepMatch && parts[1] === '*' && parts[2] === '*' && parts[3] === '*' && parts[4] === '*') {
      return { ...defaults, mode: 'interval', intervalMinutes: parseInt(stepMatch[1]) };
    }
    // Hourly interval: "0 */N * * *"
    const hourStepMatch = parts[1].match(/^\*\/(\d+)$/);
    if (parts[0] === '0' && hourStepMatch && parts[2] === '*' && parts[3] === '*' && parts[4] === '*') {
      return { ...defaults, mode: 'interval', intervalMinutes: parseInt(hourStepMatch[1]) * 60 };
    }
    return { ...defaults, mode: 'cron', cron: schedule.trim() };
  }

  // Daily at: "Daily at 3 AM"
  const dailyMatch = schedule.match(/daily\s+at\s+(\d+)\s*(AM|PM)?/i);
  if (dailyMatch) {
    let hour = parseInt(dailyMatch[1]);
    if (dailyMatch[2]?.toUpperCase() === 'PM' && hour < 12) hour += 12;
    return { ...defaults, mode: 'daily', dailyHour: hour };
  }

  return { ...defaults, cron: schedule };
}

export function buildCronString(val: ScheduleValue): string {
  switch (val.mode) {
    case 'interval':
      if (val.intervalMinutes >= 60 && val.intervalMinutes % 60 === 0) {
        return `0 */${val.intervalMinutes / 60} * * *`;
      }
      return `*/${val.intervalMinutes} * * * *`;
    case 'daily':
      return `${val.dailyMinute} ${val.dailyHour} * * *`;
    case 'windowed':
      // Windowed intervals don't map cleanly to cron — return a descriptive string
      return `Every ${val.windowIntervalMinutes}m ${val.windowStart}-${val.windowEnd}`;
    case 'cron':
      return val.cron;
  }
}

const INTERVAL_PRESETS = [5, 10, 15, 30, 60, 120, 360, 720, 1440];

function formatIntervalLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes === 60) return '1 hour';
  if (minutes < 1440) return `${minutes / 60} hours`;
  return '24 hours';
}

const DEFAULT_MODES: ScheduleMode[] = ['interval', 'daily', 'cron'];

export function ScheduleEditor({ value, defaultValue, onSave, onCancel, saving, onChange, modes = DEFAULT_MODES, inline, compact }: ScheduleEditorProps) {
  const parsed = useMemo(() => parseSchedule(value), [value]);
  const [mode, setMode] = useState<ScheduleMode>(modes.includes(parsed.mode) ? parsed.mode : modes[0]);
  const [intervalMinutes, setIntervalMinutes] = useState(parsed.intervalMinutes);
  const [dailyHour, setDailyHour] = useState(parsed.dailyHour);
  const [dailyMinute, setDailyMinute] = useState(parsed.dailyMinute);
  const [cron, setCron] = useState(parsed.cron || value);
  const [windowStart, setWindowStart] = useState(parsed.windowStart);
  const [windowEnd, setWindowEnd] = useState(parsed.windowEnd);
  const [windowIntervalMinutes, setWindowIntervalMinutes] = useState(parsed.windowIntervalMinutes);

  const currentScheduleValue: ScheduleValue = {
    mode, intervalMinutes, dailyHour, dailyMinute, cron,
    windowStart, windowEnd, windowIntervalMinutes,
  };
  const currentCron = buildCronString(currentScheduleValue);
  const isCustom = defaultValue && currentCron !== defaultValue;
  const cronValid = mode !== 'cron' || isCronValid(cron);

  // Notify parent on change
  useEffect(() => {
    onChange?.(currentScheduleValue, currentCron);
  }, [mode, intervalMinutes, dailyHour, dailyMinute, cron, windowStart, windowEnd, windowIntervalMinutes]);

  const nextRuns = useMemo(() => {
    if (mode === 'windowed') return []; // Windowed doesn't map to cron
    const expr = currentCron;
    return getNextCronRuns(expr, 3);
  }, [currentCron, mode]);

  const handleSave = () => {
    if (!cronValid) return;
    onSave?.(currentCron);
  };

  const handleReset = () => {
    if (!defaultValue) return;
    const defaults = parseSchedule(defaultValue);
    setMode(modes.includes(defaults.mode) ? defaults.mode : modes[0]);
    setIntervalMinutes(defaults.intervalMinutes);
    setDailyHour(defaults.dailyHour);
    setDailyMinute(defaults.dailyMinute);
    setCron(defaults.cron || defaultValue);
    setWindowStart(defaults.windowStart);
    setWindowEnd(defaults.windowEnd);
    setWindowIntervalMinutes(defaults.windowIntervalMinutes);
  };

  const MODE_META: Record<ScheduleMode, { icon: typeof Clock; label: string }> = {
    interval: { icon: Repeat, label: 'Interval' },
    daily: { icon: Calendar, label: 'Daily' },
    cron: { icon: Terminal, label: 'Cron' },
    windowed: { icon: Timer, label: 'Window' },
  };

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: compact ? '4px 8px' : '6px 12px',
    fontSize: compact ? 11 : 12,
    fontWeight: active ? 600 : 400, cursor: 'pointer',
    border: 'none', borderRadius: '6px 6px 0 0',
    background: active ? 'var(--bg-primary)' : 'transparent',
    color: active ? 'var(--text-primary)' : 'var(--text-muted)',
    display: 'flex', alignItems: 'center', gap: compact ? 3 : 4,
  });

  return (
    <div style={{ marginTop: inline ? 0 : 10, background: 'var(--bg-secondary)', borderRadius: 8, overflow: 'hidden' }}>
      {/* Mode tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border-color)', padding: '0 4px' }}>
        {modes.map(m => {
          const meta = MODE_META[m];
          const Icon = meta.icon;
          return (
            <button key={m} style={tabStyle(mode === m)} onClick={() => setMode(m)}>
              <Icon size={12} /> {meta.label}
            </button>
          );
        })}
      </div>

      <div style={{ padding: compact ? '8px 10px' : '12px 14px' }}>
        {/* Interval mode */}
        {mode === 'interval' && (
          <div>
            <div style={{ fontSize: compact ? 11 : 12, color: 'var(--text-muted)', marginBottom: 6 }}>Run every:</div>
            <div style={{ display: 'flex', gap: compact ? 4 : 6, flexWrap: 'wrap' }}>
              {INTERVAL_PRESETS.map(m => (
                <button
                  key={m}
                  className={`btn btn-sm ${intervalMinutes === m ? 'btn-primary' : ''}`}
                  onClick={() => setIntervalMinutes(m)}
                  style={{ fontSize: compact ? 11 : 12, padding: compact ? '2px 6px' : '4px 10px' }}
                >
                  {formatIntervalLabel(m)}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Daily mode */}
        {mode === 'daily' && (
          <div>
            <div style={{ fontSize: compact ? 11 : 12, color: 'var(--text-muted)', marginBottom: 6 }}>Run daily at:</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <select
                className="form-input"
                value={dailyHour}
                onChange={e => setDailyHour(parseInt(e.target.value))}
                style={{ width: 60, fontSize: 12, padding: '3px 4px' }}
              >
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={i}>{i.toString().padStart(2, '0')}</option>
                ))}
              </select>
              <span style={{ fontSize: 14, fontWeight: 600 }}>:</span>
              <select
                className="form-input"
                value={dailyMinute}
                onChange={e => setDailyMinute(parseInt(e.target.value))}
                style={{ width: 60, fontSize: 12, padding: '3px 4px' }}
              >
                {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map(m => (
                  <option key={m} value={m}>{m.toString().padStart(2, '0')}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* Windowed interval mode */}
        {mode === 'windowed' && (
          <div>
            <div style={{ fontSize: compact ? 11 : 12, color: 'var(--text-muted)', marginBottom: 6 }}>Interval within time window:</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <label style={{ fontSize: 11, width: 40, flexShrink: 0 }}>Every</label>
                <input
                  className="form-input"
                  type="number"
                  min={1}
                  value={windowIntervalMinutes}
                  onChange={e => setWindowIntervalMinutes(Number(e.target.value) || 5)}
                  style={{ width: 50, fontSize: 12, padding: '3px 4px' }}
                />
                <span style={{ fontSize: 11 }}>min</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <label style={{ fontSize: 11, width: 40, flexShrink: 0 }}>From</label>
                <input
                  className="form-input"
                  type="time"
                  value={windowStart}
                  onChange={e => setWindowStart(e.target.value)}
                  style={{ width: 90, fontSize: 12, padding: '3px 4px' }}
                />
                <span style={{ fontSize: 11 }}>to</span>
                <input
                  className="form-input"
                  type="time"
                  value={windowEnd}
                  onChange={e => setWindowEnd(e.target.value)}
                  style={{ width: 90, fontSize: 12, padding: '3px 4px' }}
                />
              </div>
              {(() => {
                const toMins = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
                const crossesMidnight = toMins(windowEnd) < toMins(windowStart);
                return (
                  <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                    Every {windowIntervalMinutes} min, {windowStart} → {windowEnd}
                    {crossesMidnight && ' (crosses midnight)'}
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {/* Cron mode */}
        {mode === 'cron' && (
          <div>
            <div style={{ fontSize: compact ? 11 : 12, color: 'var(--text-muted)', marginBottom: 4 }}>
              Cron <span style={{ opacity: 0.6 }}>(min hour dom mon dow)</span>
            </div>
            <input
              className="form-input"
              value={cron}
              onChange={e => setCron(e.target.value)}
              placeholder="*/30 * * * *"
              style={{
                fontFamily: 'var(--font-mono, monospace)', fontSize: compact ? 12 : 14, padding: compact ? '4px 8px' : '6px 10px',
                width: '100%',
                borderColor: cron && !cronValid ? '#ef4444' : undefined,
              }}
              onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onCancel?.(); }}
              autoFocus={!inline}
            />
            {cron && !cronValid && (
              <div style={{ fontSize: 10, color: '#ef4444', marginTop: 3 }}>
                Invalid — 5 fields required (min hour dom mon dow)
              </div>
            )}
          </div>
        )}

        {/* Next runs preview */}
        {nextRuns.length > 0 && (
          <div style={{ marginTop: 8, padding: compact ? '6px 8px' : '8px 10px', background: 'var(--bg-primary)', borderRadius: 6 }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 500, marginBottom: 3 }}>
              <Clock size={9} style={{ verticalAlign: -1 }} /> Next runs:
            </div>
            {nextRuns.map((d, i) => (
              <div key={i} style={{ fontSize: 11, color: 'var(--text-primary)', fontFamily: 'var(--font-mono, monospace)' }}>
                {formatDateTime(d)}
              </div>
            ))}
          </div>
        )}

        {/* Actions (only shown for non-inline mode) */}
        {!inline && (
          <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
            {onSave && (
              <button className="btn btn-sm btn-primary" onClick={handleSave} disabled={saving || !cronValid}>
                <Save size={12} /> Save
              </button>
            )}
            {isCustom && defaultValue && (
              <button className="btn btn-sm" onClick={handleReset} title={`Reset to: ${defaultValue}`}>
                <RotateCcw size={12} /> Reset Default
              </button>
            )}
            {onCancel && <button className="btn btn-sm" onClick={onCancel}>Cancel</button>}
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono, monospace)' }}>
              {currentCron}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
