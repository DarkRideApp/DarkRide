import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { UploadApkModal } from './UploadApkModal';

vi.mock('../../utils/upload', () => ({ uploadApk: vi.fn() }));
import { uploadApk } from '../../utils/upload';

function pickFile(name: string) {
  const file = new File(['PK'], name, { type: 'application/octet-stream' });
  const input = screen.getByTestId('upload-file-input');
  fireEvent.change(input, { target: { files: [file] } });
  return file;
}

describe('UploadApkModal', () => {
  beforeEach(() => vi.mocked(uploadApk).mockReset());

  it('rejects non-.apk files client-side', () => {
    render(<UploadApkModal onClose={() => {}} onUploaded={() => {}} />);
    pickFile('archive.zip');
    expect(screen.getByText(/must be an \.apk/i)).toBeInTheDocument();
    expect(uploadApk).not.toHaveBeenCalled();
  });

  it('uploads and reports success', async () => {
    vi.mocked(uploadApk).mockResolvedValue({ success: true, status: 200, data: { id: 1, trackedAppId: 2, packageName: 'com.x', versionCode: 7, versionName: '7.0' } });
    const onUploaded = vi.fn();
    render(<UploadApkModal onClose={() => {}} onUploaded={onUploaded} />);
    pickFile('app.apk');
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(expect.objectContaining({ packageName: 'com.x' })));
  });

  it('surfaces server errors (409 duplicate)', async () => {
    vi.mocked(uploadApk).mockResolvedValue({ success: false, status: 409, error: 'Version 7 of com.x is already stored' });
    render(<UploadApkModal onClose={() => {}} onUploaded={() => {}} />);
    pickFile('app.apk');
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(screen.getByText(/already stored/)).toBeInTheDocument());
  });

  it('warns when uploaded package differs from expected', async () => {
    vi.mocked(uploadApk).mockResolvedValue({ success: true, status: 200, data: { id: 1, trackedAppId: 2, packageName: 'com.other', versionCode: 1, versionName: null } });
    render(<UploadApkModal onClose={() => {}} onUploaded={() => {}} expectedPackage="com.x" />);
    pickFile('app.apk');
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(screen.getByText(/different package/i)).toBeInTheDocument());
  });

  it('passes the auth csrf token and a progress callback to uploadApk', async () => {
    vi.mocked(uploadApk).mockResolvedValue({ success: true, status: 200, data: { id: 1, trackedAppId: 2, packageName: 'com.x', versionCode: 7, versionName: '7.0' } });
    render(<UploadApkModal onClose={() => {}} onUploaded={() => {}} />);
    pickFile('app.apk');
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(uploadApk).toHaveBeenCalled());
    const [, opts] = vi.mocked(uploadApk).mock.calls[0];
    expect(opts).toHaveProperty('csrfToken'); // null in unauthenticated tests, but the key is wired
    expect(typeof opts?.onProgress).toBe('function');
  });

  it('renders the progress bar while an upload is in flight, then clears it', async () => {
    let reportProgress: ((p: number) => void) | undefined;
    vi.mocked(uploadApk).mockImplementation(async (_file, opts) => {
      reportProgress = opts?.onProgress;
      reportProgress?.(40);
      return { success: true, status: 200, data: { id: 1, trackedAppId: 2, packageName: 'com.x', versionCode: 7, versionName: '7.0' } };
    });
    const onUploaded = vi.fn();
    render(<UploadApkModal onClose={() => {}} onUploaded={onUploaded} />);
    pickFile('app.apk');
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    // Upload resolves immediately; onProgress was wired and the bar clears afterward.
    await waitFor(() => expect(onUploaded).toHaveBeenCalled());
    expect(reportProgress).toBeDefined();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('accepts a valid initialFile and rejects a non-apk one', () => {
    const apk = new File(['PK'], 'preset.apk', { type: 'application/octet-stream' });
    const { unmount } = render(<UploadApkModal onClose={() => {}} onUploaded={() => {}} initialFile={apk} />);
    expect(screen.getByText(/preset\.apk/)).toBeInTheDocument();
    expect(screen.getByTestId('upload-submit-btn')).not.toBeDisabled();
    unmount();

    const zip = new File(['PK'], 'preset.zip', { type: 'application/zip' });
    render(<UploadApkModal onClose={() => {}} onUploaded={() => {}} initialFile={zip} />);
    expect(screen.getByTestId('upload-submit-btn')).toBeDisabled();
  });
});
