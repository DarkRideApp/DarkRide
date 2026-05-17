import { useState } from 'react';
import { KeyValueEditor } from '@darkrideapp/plugin-sdk/react';
import type { KeyValuePair } from '@darkrideapp/plugin-sdk/react';

export default function KeyValueEditorDemo() {
  const [kvPairs, setKvPairs] = useState<KeyValuePair[]>([
    { key: 'API_KEY', value: 'abc123' },
    { key: 'TIMEOUT', value: '30' },
  ]);
  return (
    <div style={{ maxWidth: 500 }}>
      <KeyValueEditor
        pairs={kvPairs}
        onChange={setKvPairs}
        keyPlaceholder="Variable"
        valuePlaceholder="Value"
      />
    </div>
  );
}
