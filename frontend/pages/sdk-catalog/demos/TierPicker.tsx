import { useState } from 'react';
import { TierPicker } from '@darkrideapp/plugin-sdk/react';
import type { AiTier } from '@darkrideapp/plugin-sdk/react';

const MOCK_TIERS: AiTier[] = [
  { id: 1, name: 'Fast',    sortOrder: 0, isHardcoded: true,  enabledModelCount: 3, createdAt: 0, updatedAt: 0 },
  { id: 2, name: 'Quality', sortOrder: 1, isHardcoded: true,  enabledModelCount: 2, createdAt: 0, updatedAt: 0 },
  { id: 3, name: 'Custom',  sortOrder: 2, isHardcoded: false, enabledModelCount: 0, createdAt: 0, updatedAt: 0 },
];

export default function TierPickerDemo() {
  const [tierValue, setTierValue] = useState('Fast');
  return (
    <div style={{ maxWidth: 300 }}>
      <TierPicker
        tiers={MOCK_TIERS}
        value={tierValue}
        onChange={setTierValue}
        label="AI Tier"
      />
    </div>
  );
}
