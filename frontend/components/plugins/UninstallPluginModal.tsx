import React, { useState } from 'react';

export interface UninstallFootprint {
  tables: string[];
  fileStorageBytes: number;
  npmPackage: string | null;
}

interface UninstallPluginModalProps {
  pluginName: string;
  footprint: UninstallFootprint | null;
  onCancel: () => void;
  onConfirm: (preserveData: boolean) => void | Promise<void>;
}

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

export function UninstallPluginModal({
  pluginName,
  footprint,
  onCancel,
  onConfirm,
}: UninstallPluginModalProps) {
  const [busy, setBusy] = useState(false);

  const handleSafe = async () => {
    setBusy(true);
    try { await onConfirm(true); } finally { setBusy(false); }
  };

  const handleWipe = async () => {
    setBusy(true);
    try { await onConfirm(false); } finally { setBusy(false); }
  };

  const tableCount = footprint?.tables.length ?? 0;
  const dataBytes = footprint?.fileStorageBytes ?? 0;
  const hasData = tableCount > 0 || dataBytes > 0;

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onCancel}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <h3>Uninstall "{pluginName}"?</h3>

        <p style={{ marginBottom: 12 }}>
          Pick how thoroughly to uninstall. The safe option keeps your plugin
          data, so reinstalling later restores everything.
        </p>

        {footprint === null ? (
          <p style={{ fontStyle: 'italic', color: 'var(--text-secondary)' }}>
            Checking what would be removed…
          </p>
        ) : hasData ? (
          <div
            data-testid="uninstall-footprint-summary"
            style={{
              background: 'var(--bg-secondary)',
              padding: '10px 12px',
              borderRadius: 6,
              fontSize: 13,
              marginBottom: 16,
            }}
          >
            <strong>Plugin data on this server:</strong>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {tableCount > 0 && (
                <li>{tableCount} database table{tableCount === 1 ? '' : 's'} ({footprint.tables.join(', ')})</li>
              )}
              {dataBytes > 0 && (
                <li>{formatBytes(dataBytes)} of file storage in <code>data/plugins/{pluginName}/</code></li>
              )}
            </ul>
          </div>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
            No plugin data on this server — uninstall just removes the registry entry.
          </p>
        )}

        <div className="modal-footer" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSafe}
            disabled={busy}
            data-testid="uninstall-keep-data"
            autoFocus
          >
            Uninstall (keep data)
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={handleWipe}
            disabled={busy}
            data-testid="uninstall-delete-data"
          >
            {hasData
              ? `Uninstall and delete all data (${[
                  tableCount > 0 ? `${tableCount} table${tableCount === 1 ? '' : 's'}` : null,
                  dataBytes > 0 ? formatBytes(dataBytes) : null,
                ].filter(Boolean).join(', ')})`
              : 'Uninstall and delete all data'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onCancel}
            disabled={busy}
            data-testid="uninstall-cancel"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
