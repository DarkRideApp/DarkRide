import { ButtonList } from '@darkrideapp/plugin-sdk/react';
import type { ButtonListItem } from '@darkrideapp/plugin-sdk/react';

const MOCK_BUTTON_ITEMS: ButtonListItem[] = [
  { id: 'btn1', label: 'Refresh', onClick: () => {} },
  { id: 'btn2', label: 'Export', onClick: () => {} },
  { id: 'btn3', label: 'Delete', onClick: () => {}, disabled: true },
];

export default function ButtonListDemo() {
  return <ButtonList buttons={MOCK_BUTTON_ITEMS} />;
}
