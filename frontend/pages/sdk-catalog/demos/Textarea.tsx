import { Textarea } from '@darkrideapp/plugin-sdk/react';

export default function TextareaDemo() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxWidth: 400 }}>
      <Textarea placeholder="Default textarea" rows={3} />
      <Textarea placeholder="Invalid textarea" rows={3} invalid />
      <Textarea placeholder="Large textarea" rows={6} />
    </div>
  );
}
