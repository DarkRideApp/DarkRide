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

// NOTE: React.StrictMode is intentionally NOT used. The emulator WebRTC view
// (android-emulator-webrtc's <Emulator>) is a class component that opens an
// RTCPeerConnection + gRPC streams in its constructor/componentDidMount and
// does not fully tear them down on unmount. StrictMode's dev-only
// mount→unmount→remount double-invoke therefore creates two racing WebRTC
// negotiations ("SDP does not match the previously generated SDP") and crossed
// getStatus calls (null screen size → unsized video). Production builds never
// double-mount, so this only bit local dev. Re-introduce StrictMode only if
// that component is replaced or wrapped to be StrictMode-safe.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
