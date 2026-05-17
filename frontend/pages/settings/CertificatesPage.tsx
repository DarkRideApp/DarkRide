import React from 'react';
import { Navigate } from 'react-router-dom';

/**
 * Back-compat redirect — Client Certificates were merged into the Traffic
 * settings page on 2026-05-13. Bookmarks / docs pointing at
 * /ui/settings/certificates land on /ui/settings/traffic#client-certs.
 */
export function CertificatesPage() {
  return <Navigate to="/ui/settings/traffic#client-certs" replace />;
}
