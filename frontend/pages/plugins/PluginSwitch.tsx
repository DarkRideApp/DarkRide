import React from 'react';

/**
 * An on/off switch. The accessible name stays fixed and the state lives in
 * aria-checked, so a screen reader hears "Enable Maps, switch, on" instead of a
 * button whose label flips between "Enabled" and "Disabled".
 */
export function PluginSwitch({
  checked,
  label,
  title,
  onChange,
}: {
  checked: boolean;
  label: string;
  title?: string;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      className={`plugins-switch${checked ? ' is-on' : ''}`}
      onClick={onChange}
    >
      <span className="plugins-switch-knob" aria-hidden />
    </button>
  );
}
