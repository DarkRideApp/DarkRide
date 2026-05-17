import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

const SECTION_MAP: Record<string, string> = {
  notifications: 'notifications',
  integrations: 'integrations',
  ai: 'ai',
  analysis: 'analysis',
  cloud: 'cloud-storage',
  'cloud-storage': 'cloud-storage',
  // Certificates merged into Traffic on 2026-05-13 — preserve the legacy
  // ?section=certificates query param by routing to the same place.
  certificates: 'traffic',
  traffic: 'traffic',
  changelog: 'changelog',
  license: 'license',
};

export function LegacySectionRedirect() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  useEffect(() => {
    const section = params.get('section');
    if (section && SECTION_MAP[section]) {
      const extra = new URLSearchParams(params);
      extra.delete('section');
      const qs = extra.toString();
      const path = `/ui/settings/${SECTION_MAP[section]}`;
      navigate(qs ? `${path}?${qs}` : path, { replace: true });
    }
  }, [params, navigate]);
  return null;
}
