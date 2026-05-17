import { useRef } from 'react';
import { ElapsedTimer } from '@darkrideapp/plugin-sdk/react';

export default function ElapsedTimerDemo() {
  const startTime = useRef(Date.now() - 90_000).current;
  return (
    <p style={{ fontSize: 14 }}>
      Session started 90 s ago: <strong><ElapsedTimer since={startTime} /></strong>
    </p>
  );
}
