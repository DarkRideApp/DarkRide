import React from 'react';
import { ArrowLeft, Home, Square, Power } from 'lucide-react';

export type NavButton = 'back' | 'home' | 'recents' | 'power';

/**
 * The Android nav-bar buttons (Back / Home / Recents / Power), shared by the
 * scrcpy DeviceViewer and the WebRTC EmulatorView so both present an identical
 * control surface. Only the UI is shared — each caller wires `onNav` to its own
 * transport (DeviceViewer → adb `device-nav`; EmulatorView → emulator gRPC
 * sendKey), because the emulator can't use the adb input path.
 */
export function DeviceNavButtons({
  onNav,
  isAndroid = true,
  iconSize = 16,
  disabled = false,
}: {
  onNav: (button: NavButton) => void;
  isAndroid?: boolean;
  iconSize?: number;
  disabled?: boolean;
}) {
  return (
    <>
      <button className="btn btn-sm" data-testid="dv-nav-back" title="Back" disabled={disabled} onClick={() => onNav('back')}><ArrowLeft size={iconSize} /></button>
      <button className="btn btn-sm" data-testid="dv-nav-home" title="Home" disabled={disabled} onClick={() => onNav('home')}><Home size={iconSize} /></button>
      <button className="btn btn-sm" data-testid="dv-nav-recents" title="Recents" disabled={disabled} onClick={() => onNav('recents')}><Square size={iconSize} /></button>
      {isAndroid && <button className="btn btn-sm" data-testid="dv-nav-power" title="Power" disabled={disabled} onClick={() => onNav('power')}><Power size={iconSize} /></button>}
    </>
  );
}
