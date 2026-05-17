import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { PageHeader } from '@darkrideapp/plugin-sdk/react';
import { useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts';
import { useSortableTable } from '@darkrideapp/plugin-sdk/react';
import { SortableHeader } from '@darkrideapp/plugin-sdk/react';
import { useAuthOptional } from '@darkrideapp/plugin-sdk/react';

interface DbSizeSnapshot {
  sizeBytes: number;
  capturedAt: string;
}

interface TableSize {
  name: string;
  tableName: string;
  sizeBytes: number;
  rowCount: number;
  percentage: number;
}

const PIE_COLORS = [
  '#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6',
  '#8b5cf6', '#ef4444', '#14b8a6', '#f97316', '#06b6d4',
  '#84cc16', '#a855f7',
];

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

interface CloudError {
  cloudKey: string;
  error: string;
}

export function Utils() {
  useDocumentTitle('Utils');
  const auth = useAuthOptional();
  const ws = useWebSocket();
  const [dbSize, setDbSize] = useState<string>('Unknown');
  const [sizeHistory, setSizeHistory] = useState<DbSizeSnapshot[]>([]);
  const [tableSizes, setTableSizes] = useState<TableSize[]>([]);
  const [cloudErrors, setCloudErrors] = useState<CloudError[]>([]);
  const [cloudConfigured, setCloudConfigured] = useState<boolean>(false);
  const [retryingKeys, setRetryingKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!ws.connected) return;
    ws.sendRestApi('GET', '/v1/utils/info').then(res => {
      const data = res.body?.data;
      if (data?.dbSizeBytes) {
        setDbSize(`${(data.dbSizeBytes / 1024 / 1024).toFixed(1)} MB`);
      }
    }).catch(() => {});

    ws.sendRestApi('GET', '/v1/utils/db-size-history').then(res => {
      const data = res.body?.data;
      if (Array.isArray(data)) {
        setSizeHistory(data);
      }
    }).catch(() => {});

    ws.sendRestApi('GET', '/v1/utils/table-sizes').then(res => {
      const data = res.body?.data;
      if (Array.isArray(data)) {
        setTableSizes(data);
      }
    }).catch(() => {});

    ws.sendRestApi('GET', '/v1/cloud/status').then(res => {
      const data = res.body?.data;
      if (data) {
        setCloudConfigured(!!data.configured);
        setCloudErrors(Array.isArray(data.errors) ? data.errors : []);
      }
    }).catch(() => {});

  }, [ws]);

  const { sorted: sortedCloudErrors, sortKey: cloudErrSortKey, sortDir: cloudErrSortDir, onSort: onCloudErrSort } = useSortableTable(cloudErrors, 'cloudKey');

  const pieData = useMemo(() => {
    if (tableSizes.length === 0) return [];
    // Show top tables individually, group the rest into "Other"
    const total = tableSizes.reduce((sum, t) => sum + t.sizeBytes, 0);
    const MIN_PERCENTAGE = 1;
    const main: TableSize[] = [];
    let otherSize = 0;
    let otherRows = 0;
    for (const t of tableSizes) {
      const pct = total > 0 ? (t.sizeBytes / total) * 100 : 0;
      if (pct >= MIN_PERCENTAGE) {
        main.push(t);
      } else {
        otherSize += t.sizeBytes;
        otherRows += t.rowCount;
      }
    }
    const result = main.map(t => ({ name: t.name, value: t.sizeBytes, rowCount: t.rowCount }));
    if (otherSize > 0) {
      result.push({ name: 'Other', value: otherSize, rowCount: otherRows });
    }
    return result;
  }, [tableSizes]);

  const chartData = useMemo(() => {
    return sizeHistory.map(s => ({
      date: new Date(s.capturedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      sizeMB: Number((s.sizeBytes / 1024 / 1024).toFixed(2)),
      fullDate: new Date(s.capturedAt).toLocaleString(),
    }));
  }, [sizeHistory]);

  const handleDownloadDb = () => {
    const a = document.createElement('a');
    a.href = '/v1/utils/backup';
    a.download = 'darkride.db';
    a.click();
  };

  const handleRetryUpload = useCallback((cloudKey: string) => {
    setRetryingKeys(prev => new Set(prev).add(cloudKey));
    ws.sendRestApi('POST', `/v1/cloud/retry/${cloudKey}`).then(() => {
      setCloudErrors(prev => prev.filter(e => e.cloudKey !== cloudKey));
    }).catch(() => {}).finally(() => {
      setRetryingKeys(prev => { const next = new Set(prev); next.delete(cloudKey); return next; });
    });
  }, [ws]);

  const canBackup = !auth || auth.hasScope('core.system:backup');

  return (
    <div data-testid="utils-page">
      <header className="settings-page-header">
        <h1>Utilities</h1>
      </header>

      <div className="utils-section">
        <h2>Database</h2>
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div>Database Size: <strong>{dbSize}</strong></div>
            </div>
            {canBackup && (
              <button className="btn btn-primary" onClick={handleDownloadDb} data-testid="download-db-btn">
                Download Backup
              </button>
            )}
          </div>
        </div>

        {sizeHistory.length > 0 ? (
          <div className="card" data-testid="db-size-chart">
            <h3 style={{ margin: '0 0 12px 0', fontSize: 14, fontWeight: 500, color: 'var(--text-secondary, #888)' }}>
              Size History (Last 60 Days)
            </h3>
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={chartData} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="sizeGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-primary, #6366f1)" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="var(--color-primary, #6366f1)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: 'var(--text-secondary, #888)' }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: 'var(--text-secondary, #888)' }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => `${v} MB`}
                  width={64}
                />
                <Tooltip
                  contentStyle={{
                    background: 'var(--bg-secondary, #1e1e2e)',
                    border: '1px solid var(--border-color, #333)',
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                  formatter={(value: number) => [`${value} MB`, 'Size']}
                  labelFormatter={(_label: string, payload: any[]) => payload?.[0]?.payload?.fullDate || _label}
                />
                <Area
                  type="monotone"
                  dataKey="sizeMB"
                  stroke="var(--color-primary, #6366f1)"
                  strokeWidth={2}
                  fill="url(#sizeGradient)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="card" data-testid="db-size-no-data" style={{ color: 'var(--text-secondary, #888)', fontSize: 13 }}>
            No size history data yet. Data is recorded hourly.
          </div>
        )}
        {pieData.length > 0 && (
          <div className="card" data-testid="db-table-sizes" style={{ marginTop: 16 }}>
            <h3 style={{ margin: '0 0 12px 0', fontSize: 14, fontWeight: 500, color: 'var(--text-secondary, #888)' }}>
              Storage Breakdown
            </h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
              <ResponsiveContainer width={280} height={280} style={{ flex: '0 0 280px' }}>
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={120}
                    innerRadius={60}
                    paddingAngle={2}
                    strokeWidth={0}
                  >
                    {pieData.map((_entry, index) => (
                      <Cell key={index} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      background: 'var(--bg-secondary, #1e1e2e)',
                      border: '1px solid var(--border-color, #333)',
                      borderRadius: 6,
                      fontSize: 12,
                      color: 'var(--text-primary, #e0e0e0)',
                    }}
                    itemStyle={{ color: 'var(--text-primary, #e0e0e0)' }}
                    formatter={(value: number, name: string, props: any) => {
                      const rc = props.payload.rowCount;
                      const label = rc >= 0 ? `${formatBytes(value)} (${rc.toLocaleString()} rows)` : formatBytes(value);
                      return [label, name];
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div style={{ flex: 1, minWidth: 200 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border-color, #333)' }}>
                      <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500, color: 'var(--text-secondary)' }}>Table</th>
                      <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500, color: 'var(--text-secondary)' }}>Size</th>
                      <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500, color: 'var(--text-secondary)' }}>Rows</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pieData.map((entry, index) => (
                      <tr key={entry.name}>
                        <td style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{
                            display: 'inline-block', width: 10, height: 10, borderRadius: 2,
                            background: PIE_COLORS[index % PIE_COLORS.length],
                          }} />
                          {entry.name}
                        </td>
                        <td style={{ padding: '4px 8px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                          {formatBytes(entry.value)}
                        </td>
                        <td style={{ padding: '4px 8px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                          {entry.rowCount >= 0 ? entry.rowCount.toLocaleString() : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>

      {cloudConfigured && (
        <div className="utils-section" data-testid="cloud-backup-section">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            Cloud Backup
            {cloudErrors.length > 0 && (
              <span className="error-count-badge" data-testid="cloud-error-badge">{cloudErrors.length}</span>
            )}
          </h2>
          <div className="card">
            <h3 style={{ margin: '0 0 12px 0', fontSize: 14, fontWeight: 500, color: 'var(--text-secondary, #888)' }}>
              Failed Cloud Uploads
            </h3>
            {cloudErrors.length === 0 ? (
              <div style={{ color: 'var(--text-secondary, #888)', fontSize: 13 }} data-testid="cloud-no-errors">
                No failed uploads.
              </div>
            ) : (
              <table className="data-table" data-testid="cloud-errors-table">
                <thead>
                  <tr>
                    <SortableHeader label="File" sortKey="cloudKey" currentSort={cloudErrSortKey} dir={cloudErrSortDir} onSort={onCloudErrSort} />
                    <SortableHeader label="Error" sortKey="error" currentSort={cloudErrSortKey} dir={cloudErrSortDir} onSort={onCloudErrSort} />
                    <th style={{ width: 80 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {sortedCloudErrors.map(e => (
                    <tr key={e.cloudKey} data-testid={`cloud-error-row-${e.cloudKey}`}>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12, wordBreak: 'break-all' }}>{e.cloudKey}</td>
                      <td style={{ color: 'var(--color-error, #ef4444)', fontSize: 13 }}>{e.error}</td>
                      <td>
                        <button
                          className="btn btn-sm btn-secondary"
                          onClick={() => handleRetryUpload(e.cloudKey)}
                          disabled={retryingKeys.has(e.cloudKey)}
                          data-testid={`retry-btn-${e.cloudKey}`}
                        >
                          {retryingKeys.has(e.cloudKey) ? 'Retrying...' : 'Retry'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      <div className="utils-section">
        <h2>Environment</h2>
        <div className="card">
          <table className="data-table" data-testid="env-table">
            <thead>
              <tr>
                <th>Variable</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>PORT</td><td>{window.location.port || '80'}</td></tr>
              <tr><td>Frontend URL</td><td>{window.location.origin}/ui</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
