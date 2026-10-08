import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { LegacySectionRedirect } from '../LegacySectionRedirect';

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname}{loc.search}</div>;
}

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <LegacySectionRedirect />
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('LegacySectionRedirect', () => {
  it('maps a legacy ?section= to its settings page', () => {
    renderAt('/ui/settings?section=changelog');
    expect(screen.getByTestId('where')).toHaveTextContent('/ui/settings/changelog');
  });

  it('keeps unrelated query params when redirecting', () => {
    renderAt('/ui/settings?section=cloud&tab=s3');
    expect(screen.getByTestId('where')).toHaveTextContent('/ui/settings/cloud-storage?tab=s3');
  });

  it('does not redirect ?section=license: the License page no longer exists', () => {
    renderAt('/ui/settings?section=license');
    expect(screen.getByTestId('where')).toHaveTextContent('/ui/settings?section=license');
  });
});
