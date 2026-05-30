import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles.css';

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
