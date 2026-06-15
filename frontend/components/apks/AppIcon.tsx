import React, { useState } from 'react';

interface AppIconProps {
  packageName: string;
  appName: string | null;
  size?: number;
}

/** App icon from /v1/apps/icon/:pkg with a deterministic letter-tile fallback. */
export function AppIcon({ packageName, appName, size = 36 }: AppIconProps) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    const letter = (appName || packageName.split('.').pop() || '?').charAt(0).toUpperCase();
    let hash = 0;
    for (let i = 0; i < packageName.length; i++) hash = ((hash << 5) - hash + packageName.charCodeAt(i)) | 0;
    const hue = Math.abs(hash) % 360;
    return (
      <div style={{
        width: size, height: size, borderRadius: size * 0.22,
        background: `hsl(${hue}, 45%, 55%)`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: size * 0.42, fontWeight: 700, color: '#fff',
        flexShrink: 0,
      }}>
        {letter}
      </div>
    );
  }

  return (
    <img
      src={`/v1/apps/icon/${encodeURIComponent(packageName)}`}
      onError={() => setFailed(true)}
      style={{ width: size, height: size, borderRadius: size * 0.22, flexShrink: 0, background: 'var(--bg-tertiary)' }}
      alt=""
    />
  );
}
