import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CloudBrowser } from './CloudBrowser';

const mockStatusConfigured = {
  success: true,
  data: {
    configured: true,
    localCacheUsageMb: 1200,
    localCacheBudgetMb: 5120,
    filesTracked: 42,
    filesCloudOnly: 10,
    pendingUploads: 3,
    errors: [],
  },
};

const mockStatusNotConfigured = {
  success: true,
  data: {
    configured: false,
    localCacheUsageMb: 0,
    localCacheBudgetMb: 0,
    filesTracked: 0,
    filesCloudOnly: 0,
    pendingUploads: 0,
    errors: [],
  },
};

const mockStatusWithErrors = {
  success: true,
  data: {
    configured: true,
    localCacheUsageMb: 500,
    localCacheBudgetMb: 5120,
    filesTracked: 10,
    filesCloudOnly: 2,
    pendingUploads: 0,
    errors: [
      { cloudKey: 'apks/broken.apk', error: 'Upload failed' },
    ],
  },
};

const mockBrowseRoot = {
  success: true,
  data: {
    prefixes: ['apks/', 'screenshots/'],
    files: [
      { key: 'readme.txt', size: 1024, lastModified: '2025-12-01T10:00:00Z' },
      { key: 'config.json', size: 256, lastModified: '2025-11-15T08:30:00Z' },
    ],
  },
};

const mockBrowseApks = {
  success: true,
  data: {
    prefixes: ['apks/com.example/'],
    files: [
      { key: 'apks/app.apk', size: 52428800, lastModified: '2025-12-10T14:00:00Z' },
    ],
  },
};

const mockBrowseEmpty = {
  success: true,
  data: {
    prefixes: [],
    files: [],
  },
};

let fetchResponses: Record<string, any> = {};

function setupFetch(responses: Record<string, any>) {
  fetchResponses = responses;
  global.fetch = vi.fn().mockImplementation((url: string) => {
    // Match the URL to find the right response
    for (const [pattern, response] of Object.entries(fetchResponses)) {
      if (url.includes(pattern)) {
        return Promise.resolve({
          json: () => Promise.resolve(response),
        });
      }
    }
    return Promise.resolve({
      json: () => Promise.resolve({ success: true, data: {} }),
    });
  }) as any;
}

function renderCloudBrowser() {
  return render(
    <MemoryRouter>
      <CloudBrowser />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  // Default: configured with root browse data
  setupFetch({
    '/v1/cloud/status': mockStatusConfigured,
    '/v1/cloud/browse': mockBrowseRoot,
  });
});

describe('CloudBrowser', () => {
  it('renders the cloud browser page', async () => {
    renderCloudBrowser();
    await waitFor(() => {
      expect(screen.getByTestId('cloud-browser-page')).toBeInTheDocument();
    });
  });

  it('renders "not configured" message when status returns configured: false', async () => {
    setupFetch({
      '/v1/cloud/status': mockStatusNotConfigured,
      '/v1/cloud/browse': mockBrowseEmpty,
    });
    renderCloudBrowser();
    await waitFor(() => {
      expect(screen.getByTestId('cloud-not-configured')).toBeInTheDocument();
      expect(screen.getByText(/Cloud storage is not configured/)).toBeInTheDocument();
    });
  });

  it('renders status bar with cache usage when configured', async () => {
    renderCloudBrowser();
    await waitFor(() => {
      expect(screen.getByTestId('cloud-status-bar')).toBeInTheDocument();
      expect(screen.getByTestId('cache-usage')).toHaveTextContent('1.2 GB');
      expect(screen.getByTestId('cache-usage')).toHaveTextContent('5.0 GB');
    });
  });

  it('renders pending uploads count', async () => {
    renderCloudBrowser();
    await waitFor(() => {
      expect(screen.getByTestId('pending-uploads')).toHaveTextContent('3');
    });
  });

  it('renders error banner when status has errors', async () => {
    setupFetch({
      '/v1/cloud/status': mockStatusWithErrors,
      '/v1/cloud/browse': mockBrowseRoot,
    });
    renderCloudBrowser();
    await waitFor(() => {
      expect(screen.getByTestId('cloud-error-banner')).toBeInTheDocument();
      expect(screen.getByText(/Upload failed/)).toBeInTheDocument();
    });
  });

  it('renders folder and file entries from browse data', async () => {
    renderCloudBrowser();
    await waitFor(() => {
      expect(screen.getByTestId('folder-apks')).toBeInTheDocument();
      expect(screen.getByTestId('folder-screenshots')).toBeInTheDocument();
      expect(screen.getByTestId('file-readme.txt')).toBeInTheDocument();
      expect(screen.getByTestId('file-config.json')).toBeInTheDocument();
    });
  });

  it('shows file sizes in human-readable format', async () => {
    renderCloudBrowser();
    await waitFor(() => {
      const readmeRow = screen.getByTestId('file-readme.txt');
      expect(readmeRow).toHaveTextContent('1 KB');
    });
  });

  it('clicking a folder updates the prefix (navigates deeper)', async () => {
    // First render with root data
    setupFetch({
      '/v1/cloud/status': mockStatusConfigured,
      '/v1/cloud/browse': mockBrowseRoot,
    });
    renderCloudBrowser();

    await waitFor(() => {
      expect(screen.getByTestId('folder-apks')).toBeInTheDocument();
    });

    // Update fetch to return apks subfolder data on next browse call
    setupFetch({
      '/v1/cloud/status': mockStatusConfigured,
      '/v1/cloud/browse': mockBrowseApks,
    });

    fireEvent.click(screen.getByTestId('folder-apks'));

    await waitFor(() => {
      // Should now show the apks subfolder content
      expect(screen.getByTestId('file-app.apk')).toBeInTheDocument();
      expect(screen.getByText('50.0 MB')).toBeInTheDocument();
    });
  });

  it('breadcrumb navigation works - clicking root breadcrumb goes back', async () => {
    // Start at root
    setupFetch({
      '/v1/cloud/status': mockStatusConfigured,
      '/v1/cloud/browse': mockBrowseRoot,
    });
    renderCloudBrowser();

    await waitFor(() => {
      expect(screen.getByTestId('folder-apks')).toBeInTheDocument();
    });

    // Navigate into apks/
    setupFetch({
      '/v1/cloud/status': mockStatusConfigured,
      '/v1/cloud/browse': mockBrowseApks,
    });
    fireEvent.click(screen.getByTestId('folder-apks'));

    await waitFor(() => {
      expect(screen.getByTestId('file-app.apk')).toBeInTheDocument();
    });

    // breadcrumb-0 is always the root '/'
    // breadcrumb-1 is 'apks'
    expect(screen.getByTestId('breadcrumb-0')).toHaveTextContent('/');
    expect(screen.getByTestId('breadcrumb-1')).toHaveTextContent('apks');

    // Click root breadcrumb to go back
    setupFetch({
      '/v1/cloud/status': mockStatusConfigured,
      '/v1/cloud/browse': mockBrowseRoot,
    });
    fireEvent.click(screen.getByTestId('breadcrumb-0'));

    await waitFor(() => {
      expect(screen.getByTestId('folder-apks')).toBeInTheDocument();
      expect(screen.getByTestId('file-readme.txt')).toBeInTheDocument();
    });
  });

  it('filter input filters files and folders by name', async () => {
    renderCloudBrowser();

    await waitFor(() => {
      expect(screen.getByTestId('folder-apks')).toBeInTheDocument();
    });

    const filterInput = screen.getByTestId('filter-input');
    fireEvent.change(filterInput, { target: { value: 'readme' } });

    // Only the matching file should remain
    expect(screen.queryByTestId('folder-apks')).not.toBeInTheDocument();
    expect(screen.queryByTestId('folder-screenshots')).not.toBeInTheDocument();
    expect(screen.getByTestId('file-readme.txt')).toBeInTheDocument();
    expect(screen.queryByTestId('file-config.json')).not.toBeInTheDocument();
  });

  it('shows empty state when folder has no contents', async () => {
    setupFetch({
      '/v1/cloud/status': mockStatusConfigured,
      '/v1/cloud/browse': mockBrowseEmpty,
    });
    renderCloudBrowser();

    await waitFor(() => {
      expect(screen.getByText('This folder is empty')).toBeInTheDocument();
    });
  });

  it('has a refresh button', async () => {
    renderCloudBrowser();
    await waitFor(() => {
      expect(screen.getByTestId('refresh-btn')).toBeInTheDocument();
    });
  });
});
