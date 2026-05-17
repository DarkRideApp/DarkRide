import { useState } from 'react';
import { Button, KeyboardShortcutsHelp } from '@darkrideapp/plugin-sdk/react';

export default function KeyboardShortcutsHelpDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Show keyboard shortcuts</Button>
      {open && (
        <KeyboardShortcutsHelp onClose={() => setOpen(false)} />
      )}
    </>
  );
}
