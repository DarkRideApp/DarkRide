import { Select } from '@darkrideapp/plugin-sdk/react';

export default function SelectDemo() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxWidth: 300 }}>
      <Select aria-label="Default select">
        <option>Option one</option>
        <option>Option two</option>
        <option>Option three</option>
      </Select>
      <Select aria-label="Invalid select" invalid>
        <option>Invalid state</option>
      </Select>
    </div>
  );
}
