import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { WebSocketContext, ToastProvider } from '@darkrideapp/plugin-sdk/react';
import { PipelinesList } from './PipelinesList';
import { createMockWs, withProviders, mockPipelineVersion, calledPaths } from './testing';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';

function postBody(ws: WebSocketContextValue, key: string): any {
  const call = (ws.sendRestApi as unknown as { mock: { calls: unknown[][] } }).mock.calls.find(c => `${c[0]} ${c[1]}` === key);
  return call?.[2];
}

describe('PipelinesList', () => {
  it('lists every pipeline by its real name', async () => {
    const ws = createMockWs({
      pipelines: [
        { id: 1, name: 'APK Analysis', pipelineVersionId: 1, graph: mockPipelineVersion().graph },
        { id: 2, name: 'My New Pipeline', pipelineVersionId: 2, graph: { nodes: [], edges: [] } },
      ],
    });
    render(<PipelinesList />, { wrapper: withProviders(ws) });

    await waitFor(() => expect(screen.getByText('APK Analysis')).toBeInTheDocument());
    expect(screen.getByText('My New Pipeline')).toBeInTheDocument();
  });

  it('shows an empty state when there are no pipelines yet', async () => {
    const ws = createMockWs({ pipelines: [] });
    render(<PipelinesList />, { wrapper: withProviders(ws) });
    await waitFor(() => expect(screen.getByText(/no pipelines yet/i)).toBeInTheDocument());
  });

  it('filters the list by the search box', async () => {
    const ws = createMockWs({
      pipelines: [
        { id: 1, name: 'APK Analysis', pipelineVersionId: 1, graph: null },
        { id: 2, name: 'My New Pipeline', pipelineVersionId: 2, graph: null },
      ],
    });
    render(<PipelinesList />, { wrapper: withProviders(ws) });
    await waitFor(() => expect(screen.getByText('APK Analysis')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText(/filter by name/i), { target: { value: 'new' } });
    expect(screen.queryByText('APK Analysis')).not.toBeInTheDocument();
    expect(screen.getByText('My New Pipeline')).toBeInTheDocument();
  });

  it('creating a new pipeline POSTs it with an empty graph', async () => {
    const ws = createMockWs({ pipelines: [], routes: { 'POST /v1/ai-pipelines': () => ({ success: true, data: { id: 9 } }) } });
    render(<PipelinesList />, { wrapper: withProviders(ws) });
    await waitFor(() => expect(screen.getByText(/no pipelines yet/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /new pipeline/i }));
    fireEvent.change(screen.getByLabelText('New pipeline name'), { target: { value: 'My Pipeline' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(calledPaths(ws)).toContain('POST /v1/ai-pipelines'));
    expect(postBody(ws, 'POST /v1/ai-pipelines')).toEqual({ name: 'My Pipeline', graph: { nodes: [], edges: [] } });
  });

  it('navigates to the new pipeline\'s own editor route after creating it', async () => {
    const ws = createMockWs({ pipelines: [], routes: { 'POST /v1/ai-pipelines': () => ({ success: true, data: { id: 9 } }) } });
    render(
      <WebSocketContext.Provider value={ws}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/ui/pipelines']}>
            <Routes>
              <Route path="/ui/pipelines" element={<PipelinesList />} />
              <Route path="/ui/pipelines/:id" element={<div>Editor for pipeline 9</div>} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </WebSocketContext.Provider>,
    );
    await waitFor(() => expect(screen.getByText(/no pipelines yet/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /new pipeline/i }));
    fireEvent.change(screen.getByLabelText('New pipeline name'), { target: { value: 'My Pipeline' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(screen.getByText('Editor for pipeline 9')).toBeInTheDocument());
  });

  it('navigates to a pipeline\'s own editor route when its row is clicked', async () => {
    const ws = createMockWs({ pipelines: [{ id: 5, name: 'APK Analysis', pipelineVersionId: 1, graph: null }] });
    render(
      <WebSocketContext.Provider value={ws}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/ui/pipelines']}>
            <Routes>
              <Route path="/ui/pipelines" element={<PipelinesList />} />
              <Route path="/ui/pipelines/:id" element={<div>Editor for pipeline 5</div>} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </WebSocketContext.Provider>,
    );
    await waitFor(() => expect(screen.getByText('APK Analysis')).toBeInTheDocument());

    fireEvent.click(screen.getByText('APK Analysis'));
    await waitFor(() => expect(screen.getByText('Editor for pipeline 5')).toBeInTheDocument());
  });

  it('shows an error instead of creating when the name is blank', async () => {
    const ws = createMockWs({ pipelines: [] });
    render(<PipelinesList />, { wrapper: withProviders(ws) });
    await waitFor(() => expect(screen.getByText(/no pipelines yet/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /new pipeline/i }));
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    expect(screen.getByRole('alert')).toHaveTextContent(/give the new pipeline a name/i);
    expect(calledPaths(ws)).not.toContain('POST /v1/ai-pipelines');
  });
});
