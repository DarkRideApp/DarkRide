import { useState } from 'react';
import { Button, ConfirmDialog } from '@darkrideapp/plugin-sdk/react';

export default function ConfirmDialogDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>Open confirm dialog</Button>
      {open && (
        <ConfirmDialog
          title="Delete item?"
          message="This action cannot be undone. Are you sure you want to delete this item?"
          confirmLabel="Delete"
          onConfirm={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      )}
    </>
  );
}
