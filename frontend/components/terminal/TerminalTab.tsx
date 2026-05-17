import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';

interface TerminalTabProps {
  sessionId: string;
  type: 'host' | 'device';
  deviceId?: string;         // required for type='device'
  visible: boolean;          // false = hidden but kept alive (display:none)
  onExit: () => void;        // called when pty exits
}

export function TerminalTab({ sessionId, type, deviceId, visible, onExit }: TerminalTabProps) {
  const ws = useWebSocket();
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const exitedRef = useRef(false);
  // Wrap onExit in a ref so the effect doesn't re-run when the callback identity changes
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  const prefix = type === 'host' ? 'host-shell' : 'adb-shell';

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'Menlo', 'Consolas', 'DejaVu Sans Mono', monospace",
      theme: {
        background: '#1e293b',
        foreground: '#e2e8f0',
        cursor: '#e2e8f0',
      },
    });
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
