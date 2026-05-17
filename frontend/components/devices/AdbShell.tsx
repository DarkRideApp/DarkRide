import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';

interface AdbShellProps {
  deviceId: string;
  onClose: () => void;
}

export function AdbShell({ deviceId, onClose }: AdbShellProps) {
  const ws = useWebSocket();
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const exitedRef = useRef(false);

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

    // Fit after a frame so the container has dimensions
    requestAnimationFrame(() => {
      fitAddon.fit();

      // Start the shell with the terminal dimensions
      ws.sendMessage('adb-shell/start', {
        deviceId,
        cols: terminal.cols,
        rows: terminal.rows,
      });
    });

    // Forward user input to backend
    const inputDisposable = terminal.onData((data: string) => {
      ws.sendMessage('adb-shell/input', { data });
    });

    // Subscribe to shell output
    const unsubOutput = ws.subscribe('adb-shell/output', (msg: { deviceId: string; data: string }) => {
      if (msg.deviceId !== deviceId) return;
      terminal.write(msg.data);
    });

    // Subscribe to shell exit
    const unsubExit = ws.subscribe('adb-shell/exit', (msg: { deviceId: string; exitCode: number }) => {
      if (msg.deviceId !== deviceId) return;
      exitedRef.current = true;
      terminal.write('\r\n\x1b[90m--- Session ended (exit code: ' + msg.exitCode + ') ---\x1b[0m\r\n');
    });

    // Resize handling
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      ws.sendMessage('adb-shell/resize', {
        cols: terminal.cols,
        rows: terminal.rows,
      });
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      inputDisposable.dispose();
      unsubOutput();
      unsubExit();
      ws.sendMessage('adb-shell/stop', {});
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [deviceId, ws]);

  return (
    <div className="adb-shell-panel" data-testid="adb-shell-panel">
      <div className="adb-shell-header">
        <span>ADB Shell</span>
        <button
          className="modal-close"
          onClick={onClose}
          data-testid="adb-shell-close"
          title="Close terminal"
        >
          &times;
        </button>
      </div>
      <div
        className="adb-shell-body"
        ref={containerRef}
        data-testid="adb-shell-body"
      />
    </div>
  );
}
