import { useState } from 'react';
import { Button, Modal } from '@darkrideapp/plugin-sdk/react';

export default function ModalDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open modal</Button>
      {open && (
        <Modal title="Example Modal" onClose={() => setOpen(false)}>
          <p style={{ margin: 0, fontSize: 14 }}>This is the modal body. Close with the × button or press Escape.</p>
        </Modal>
      )}
    </>
  );
}
