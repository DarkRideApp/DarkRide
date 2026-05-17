import { FilterBar, FilterField } from '@darkrideapp/plugin-sdk/react';

export default function FilterBarDemo() {
  return (
    <FilterBar>
      <FilterField label="Status">
        <select className="form-input" style={{ minWidth: 120 }}>
          <option>All</option>
          <option>Online</option>
          <option>Offline</option>
        </select>
      </FilterField>
      <FilterField label="Search">
        <input className="form-input" placeholder="Filter by name…" style={{ minWidth: 200 }} />
      </FilterField>
    </FilterBar>
  );
}
