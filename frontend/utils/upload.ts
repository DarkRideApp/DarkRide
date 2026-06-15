export interface UploadResult {
  success: boolean;
  status: number;
  data?: { id: number; trackedAppId: number; packageName: string; versionCode: number; versionName: string | null };
  error?: string;
}

/**
 * Upload an APK to POST /v1/apps/upload as multipart field "apk".
 * Uses XMLHttpRequest so onProgress gets real upload progress events.
 */
export function uploadApk(
  file: File,
  opts: { csrfToken?: string | null; onProgress?: (percent: number) => void } = {},
): Promise<UploadResult> {
  return new Promise(resolve => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/v1/apps/upload');
    if (opts.csrfToken) xhr.setRequestHeader('X-CSRF-Token', opts.csrfToken);
    xhr.upload.onprogress = e => {
      if (e.lengthComputable && opts.onProgress) opts.onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        resolve({ success: xhr.status === 200 && body.success, status: xhr.status, data: body.data, error: body.error });
      } catch {
        resolve({ success: false, status: xhr.status, error: `Upload failed (HTTP ${xhr.status})` });
      }
    };
    xhr.onerror = () => resolve({ success: false, status: 0, error: 'Network error during upload' });
    const form = new FormData();
    form.append('apk', file);
    xhr.send(form);
  });
}
