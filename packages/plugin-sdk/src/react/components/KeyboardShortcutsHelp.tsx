import React from 'react';
import { Modal } from './Modal';
import { Keyboard } from 'lucide-react';

interface Shortcut {
  keys: string[];
  description: string;
}

interface ShortcutGroup {
  label: string;
  shortcuts: Shortcut[];
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    label: 'Global',
    shortcuts: [
      { keys: ['Ctrl', 'K'], description: 'Open command palette' },
      { keys: ['?'], description: 'Show keyboard shortcuts' },
    ],
  },
  {
    label: 'Editors (Automation, Frida)',
    shortcuts: [
      { keys: ['Ctrl', 'S'], description: 'Save current editor' },
    ],
  },
  {
    label: 'Request Builder',
    shortcuts: [
      { keys: ['Ctrl', 'Enter'], description: 'Send request' },
    ],
  },
  {
    label: 'Code Browser',
    shortcuts: [
      { keys: ['Ctrl', 'Shift', 'F'], description: 'Toggle code search panel' },
    ],
  },
  {
    label: 'Device View',
    shortcuts: [
      { keys: ['Any key'], description: 'Forward keypress to connected device (when not in a text field)' },
    ],
  },
];

interface KeyboardShortcutsHelpProps {
  onClose: () => void;
}

export function KeyboardShortcutsHelp({ onClose }: KeyboardShortcutsHelpProps) {
  return (
    <Modal title="Keyboard Shortcuts" onClose={onClose}>
      <div className="shortcuts-help">
        {SHORTCUT_GROUPS.map((group) => (
          <div key={group.label} className="shortcuts-group">
            <div className="shortcuts-group-label">{group.label}</div>
            <table className="shortcuts-table">
              <tbody>
                {group.shortcuts.map((shortcut) => (
                  <tr key={shortcut.description}>
                    <td className="shortcuts-keys">
                      {shortcut.keys.map((key, i) => (
                        <React.Fragment key={i}>
                          {i > 0 && <span className="shortcuts-plus">+</span>}
                          <kbd>{key}</kbd>
                        </React.Fragment>
                      ))}
                    </td>
                    <td className="shortcuts-desc">{shortcut.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </Modal>
  );
}

interface KeyboardShortcutsButtonProps {
  onClick: () => void;
}

export function KeyboardShortcutsButton({ onClick }: KeyboardShortcutsButtonProps) {
  return (
    <button
      className="shortcuts-fab"
      onClick={onClick}
      aria-label="Keyboard shortcuts"
      title="Keyboard shortcuts (?)"
    >
      <Keyboard size={14} />
    </button>
  );
}
