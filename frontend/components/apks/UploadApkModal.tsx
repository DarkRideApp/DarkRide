import React, { useCallback, useState } from 'react';
import { Upload } from 'lucide-react';
import { Modal, useAuthOptional } from '@darkrideapp/plugin-sdk/react';
import { uploadApk } from '../../utils/upload';
import { formatBytes } from '../../utils/format';

interface UploadApkModalProps {
  onClose: () => void;
  onUploaded: (data: { id: number; trackedAppId: number; packageName: string; versionCode: number; versionName: string | null }) => void;
  /** When set (App Detail), warn if the APK's package differs. */
  expectedPackage?: string;
  /** Pre-selected file (from drag-and-drop on the library). */
  initialFile?: File | null;
}

export function UploadApkModal({ onClose, onUploaded, expectedPackage, initialFile }: UploadApkModalProps) {
  const isApk = (f: File) => f.name.toLowerCase().endsWith('.apk');
  const auth = useAuthOptional();
  // A drag-dropped initialFile must pass the same .apk gate as a picked one.
  const [file, setFile] = useState<File | null>(initialFile && isApk(initialFile) ? initialFile : null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  const pick = useCallback((f: File | null) => {
    setError(null); setWarning(null);
    if (f && !isApk(f)) {
      setFile(null);
      setError('File must be an .apk');
      return;
    }
    setFile(f);
  }, []);

  const doUpload = useCallback(async () => {
    if (!file || progress !== null) return;
    setError(null);
    setProgress(0);
    const result = await uploadApk(file, {
      csrfToken: auth?.csrfToken ?? null,
      onProgress: setProgress,
    });
    setProgress(null);
    if (!result.success) {
      setError(result.error || 'Upload failed');
      return;
    }
    if (expectedPackage && result.data && result.data.packageName !== expectedPackage) {
      setWarning(`Uploaded APK is a different package (${result.data.packageName}) — it was filed under that app instead.`);
    }
    if (result.data) onUploaded(result.data);
  }, [file, progress, auth, expectedPackage, onUploaded]);

  return (
    <Modal title="Upload APK" onClose={onClose}>
      <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--text-secondary)' }}>
        The APK's package name and version are read from its manifest; analysis starts automatically.
      </div>
      <label
        style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
          padding: 24, border: '1px dashed var(--border-color)', borderRadius: 8,
          cursor: 'pointer', marginBottom: 12, color: 'var(--text-muted)', fontSize: 13,
        }}
      >
        <Upload size={22} strokeWidth={1.5} />
        {file ? <span style={{ color: 'var(--text-primary)' }}>{file.name} · {formatBytes(file.size)}</span> : 'Choose an .apk file'}
        <input
          type="file"
          accept=".apk"
          style={{ display: 'none' }}
          data-testid="upload-file-input"
          onChange={e => pick(e.target.files?.[0] ?? null)}
        />
      </label>
      {progress !== null && (
        <div style={{ marginBottom: 12 }}>
          <div className="status-strip-bar" role="progressbar" aria-label="Upload progress" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} style={{ width: '100%' }}>
            <div className="status-strip-bar-fill" style={{ width: `${progress}%` }} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Uploading… {progress}%</div>
        </div>
      )}
      {error && (
        <div className="status-strip status-strip-error" data-testid="upload-error" style={{ animation: 'none' }}>
          <span className="status-strip-label">{error}</span>
        </div>
      )}
      {warning && (
        <div className="status-strip status-strip-info" data-testid="upload-warning">
          <span className="status-strip-detail">{warning}</span>
        </div>
      )}
      <button
        className="btn btn-primary"
        disabled={!file || progress !== null}
        onClick={doUpload}
        data-testid="upload-submit-btn"
      >
        {progress !== null ? 'Uploading…' : 'Upload'}
      </button>
    </Modal>
  );
}
