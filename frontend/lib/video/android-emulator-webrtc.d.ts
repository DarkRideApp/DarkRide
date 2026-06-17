// Minimal ambient types for the (untyped) android-emulator-webrtc package.
// Only the surface DarkRide's EmulatorView uses is declared.
declare module 'android-emulator-webrtc/emulator' {
  import * as React from 'react';

  export interface EmulatorProps {
    /** gRPC-web endpoint base; the client appends `/<Service>/<Method>`. */
    uri: string;
    /** Authenticator with authHeader()/unauthorized(); null = no-op (cookie auth). */
    auth?: { authHeader(): Record<string, string>; unauthorized(): void } | null;
    /** Rendering engine. */
    view?: 'webrtc' | 'png';
    muted?: boolean;
    volume?: number;
    width?: number;
    height?: number;
    /** Only for the go webgrpc proxy. */
    poll?: boolean;
    gps?: unknown;
    onStateChange?: (state: 'connecting' | 'connected' | 'disconnected') => void;
    onAudioStateChange?: (available: boolean) => void;
    onError?: (error: unknown) => void;
  }

  export class Emulator extends React.Component<EmulatorProps> {
    /** Send a hardware key over the live JSEP input channel (webrtc engine).
     *  e.g. 'GoHome', 'GoBack', 'AppSwitch', 'Power', 'AudioVolumeUp'. */
    sendKey(key: string): void;
  }
}
