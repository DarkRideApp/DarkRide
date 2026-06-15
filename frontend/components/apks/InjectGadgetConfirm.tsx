import React from 'react';
import { ConfirmDialog } from '@darkrideapp/plugin-sdk/react';

interface InjectGadgetConfirmProps {
  packageName: string;
  versionCode: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Confirm for the heavyweight Frida gadget injection (repackages the APK). */
export function InjectGadgetConfirm({ packageName, versionCode, onConfirm, onCancel }: InjectGadgetConfirmProps) {
  return (
    <ConfirmDialog
      title="Inject Frida Gadget"
      message={`Build a Frida-gadget copy of ${packageName} (version code ${versionCode})? This repackages and re-signs the APK with the bundled frida-gadget library — it can take a minute. The original APK is untouched.`}
      confirmLabel="Inject Gadget"
      danger={false}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
