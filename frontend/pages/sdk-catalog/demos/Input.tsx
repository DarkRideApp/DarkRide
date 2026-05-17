import { Input } from '@darkrideapp/plugin-sdk/react';

export default function InputDemo() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxWidth: 400 }}>
      <Input placeholder="Default text input" />
      <Input placeholder="Invalid input" invalid />
      <Input type="password" placeholder="Password input" />
      <Input type="number" placeholder="Number input" />
      <Input type="search" placeholder="Search input" />
    </div>
  );
}
