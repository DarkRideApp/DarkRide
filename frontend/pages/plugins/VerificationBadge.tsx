import React from 'react';
import { ShieldCheck, ShieldAlert, ShieldX } from 'lucide-react';
import type { EntryVerification } from './catalog';

type Tone = 'ok' | 'warn' | 'danger' | 'muted';

function describe(v: EntryVerification): { label: string; tone: Tone; Icon: typeof ShieldCheck } {
  switch (v.status) {
    case 'verified':
      return { label: `Verified by ${v.keyLabel ?? v.signedBy ?? 'unknown'}`, tone: 'ok', Icon: ShieldCheck };
    case 'unsigned':
      return { label: 'Unverified', tone: 'warn', Icon: ShieldAlert };
    case 'untrusted':
      return { label: 'Unknown signer', tone: 'danger', Icon: ShieldX };
    case 'signed':
      return { label: `Signed by ${v.signedBy}`, tone: 'muted', Icon: ShieldCheck };
  }
}

/**
 * Trust marker for a plugin. Icon-only in a row (the label is its accessible
 * name and tooltip); with `showText` it also prints the label, for the drawer.
 */
export function VerificationBadge({ verification, showText }: { verification: EntryVerification; showText?: boolean }) {
  const { label, tone, Icon } = describe(verification);
  return (
    <span className={`plugins-trust plugins-trust--${tone}`} role="img" aria-label={label} title={label}>
      <Icon size={14} aria-hidden />
      {showText && <span className="plugins-trust-text" aria-hidden>{label}</span>}
    </span>
  );
}
