import React from 'react';
import { Outlet } from 'react-router-dom';
import { SettingsSidebar } from './SettingsSidebar';
import { LegacySectionRedirect } from './LegacySectionRedirect';
import { RestartBanner } from '@darkrideapp/plugin-sdk/react';

export function SettingsLayout() {
  return (
    <div className="settings-layout">
      <LegacySectionRedirect />
      <SettingsSidebar />
      <div className="settings-content">
        <RestartBanner />
        <Outlet />
      </div>
    </div>
  );
}
