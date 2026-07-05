import React, { useEffect, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { createShellTerminal } from './createShellTerminal';

interface TerminalTabProps {
  sessionId: string;
  type: 'host' | 'device';
  deviceId?: string;         // required for type='device'
  initialCommand?: string;   // auto-run once after the shell is ready
  visible: boolean;          // false = hidden but kept alive (display:none)
  onExit: () => void;        // called when pty exits
}

export function TerminalTab({ sessionId, type, deviceId, initialCommand, visible, onExit }: TerminalTabProps) {
  const ws = useWebSocket();
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const exitedRef = useRef(false);
  // Wrap onExit in a ref so the effect doesn't re-run when the callback identity changes
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  // initialCommand via refs so the start effect doesn't re-run (and re-spawn the
  // pty) if the prop identity changes. Sent once, after the shell's first output.
  const initialCommandRef = useRef(initialCommand);
  initialCommandRef.current = initialCommand;
  const initialSentRef = useRef(false);

  const prefix = type === 'host' ? 'host-shell' : 'adb-shell';

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // OSC 52 clipboard auto-copy is only safe for the host shell — its PTY output
    // is the operator's own local shell. A device's ADB shell can be driven by an
    // untrusted/compromised app, so it never gets to write to the OS clipboard on
    // its own; the operator can still explicitly select+copy text either way.
    const terminal = createShellTerminal({ allowOscClipboardWrite: type === 'host' });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Defer start so React StrictMode cleanup can cancel before the pty spawns.
    // Without this, dev mode double-mounts spawn two ptys and output is doubled.
    const startTimer = setTimeout(() => {
      fitAddon.fit();

      const startPayload: Record<string, unknown> = {
        sessionId,
        cols: terminal.cols,
        rows: terminal.rows,
      };
      if (type === 'device' && deviceId) {
        startPayload.deviceId = deviceId;
      }
      ws.sendMessage(`${prefix}/start`, startPayload);
    }, 0);

    // Forward user input to backend
    const inputDisposable = terminal.onData((data: string) => {
      ws.sendMessage(`${prefix}/input`, { sessionId, data });
    });

    // Subscribe to shell output — filter by sessionId
    const unsubOutput = ws.subscribe(
      `${prefix}/output`,
      (msg: { sessionId: string; data: string }) => {
        if (msg.sessionId !== sessionId) return;
        terminal.write(msg.data);
        // Run the requested command once the shell has produced its first
        // output (its prompt is ready), then never again for this session.
        if (initialCommandRef.current && !initialSentRef.current) {
          initialSentRef.current = true;
          ws.sendMessage(`${prefix}/input`, { sessionId, data: initialCommandRef.current + '\r' });
        }
      }
    );

    // Subscribe to shell exit — filter by sessionId
    const unsubExit = ws.subscribe(
      `${prefix}/exit`,
      (msg: { sessionId: string; exitCode: number }) => {
        if (msg.sessionId !== sessionId) return;
        exitedRef.current = true;
        terminal.write(
          '\r\n\x1b[90m--- Session ended (exit code: ' + msg.exitCode + ') ---\x1b[0m\r\n'
        );
        onExitRef.current();
      }
    );

    // Resize handling
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      ws.sendMessage(`${prefix}/resize`, {
        sessionId,
        cols: terminal.cols,
        rows: terminal.rows,
      });
    });
    resizeObserver.observe(container);

    return () => {
      clearTimeout(startTimer);
      resizeObserver.disconnect();
      inputDisposable.dispose();
      unsubOutput();
      unsubExit();
      ws.sendMessage(`${prefix}/stop`, { sessionId });
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId, type, deviceId, prefix, ws]);

  // When becoming visible again, refit so the terminal fills the container
  useEffect(() => {
    if (visible && fitAddonRef.current) {
      requestAnimationFrame(() => {
        fitAddonRef.current?.fit();
      });
    }
  }, [visible]);

  return (
    <div
      ref={containerRef}
      data-testid="terminal-tab-body"
      style={{
        display: visible ? 'block' : 'none',
        width: '100%',
        height: '100%',
        backgroundColor: '#1e293b',
      }}
    />
  );
}
