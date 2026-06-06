import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Configure Monaco web workers globally so every page (host's
// AutomationEditor, CodeBrowser, plus any plugin page that uses the SDK's
// <ManagedAutomationScriptIDE>) gets language features without each
// caller having to re-do this. Vite resolves the `new URL` worker paths
// to bundled chunks at build time. Set before any code that might import
// monaco-editor — keep this at the top of main.tsx.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'typescript' || label === 'javascript') {
      return new Worker(
        new URL('monaco-editor/esm/vs/language/typescript/ts.worker.js', import.meta.url),
        { type: 'module' },
      );
    }
    return new Worker(
      new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
      { type: 'module' },
    );
  },
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
