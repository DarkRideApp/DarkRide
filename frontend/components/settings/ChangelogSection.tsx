import React, { useState, useCallback, useEffect } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { SectionCard, SectionHeading } from './SettingsShared';

interface ChangelogCommit {
  hash: string;
  shortHash: string;
  title: string;
  body: string | null;
  author: string;
  date: string;
}

interface ChangelogResponse {
  data: {
    items: ChangelogCommit[];
    total: number;
    limit: number;
    offset: number;
  };
}

const PAGE_SIZE = 30;

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function groupByDate(commits: ChangelogCommit[]): Map<string, ChangelogCommit[]> {
  const groups = new Map<string, ChangelogCommit[]>();
  for (const commit of commits) {
    const dateKey = commit.date.slice(0, 10);
    const existing = groups.get(dateKey);
    if (existing) {
      existing.push(commit);
    } else {
      groups.set(dateKey, [commit]);
    }
  }
  return groups;
}

export function ChangelogSection() {
  const ws = useWebSocket();
  const [commits, setCommits] = useState<ChangelogCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const fetchChangelog = useCallback(async (offset = 0, append = false) => {
    try {
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setError(null);
      const res = await ws.sendRestApi('GET', `/v1/changelog?limit=${PAGE_SIZE}&offset=${offset}`);
      const body: ChangelogResponse = res.body;
      const { items, total, limit, offset: respOffset } = body.data;
      setCommits(prev => append ? [...prev, ...items] : items);
      const newOffset = respOffset + limit;
      setHasMore(newOffset < total);
      setNextOffset(newOffset);
    } catch {
      setError('Failed to load changelog.');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [ws]);

  useEffect(() => {
    if (ws.connected) {
      fetchChangelog();
    }
  }, [ws.connected, fetchChangelog]);

  const grouped = groupByDate(commits);

  return (
    <div id="section-changelog" data-testid="changelog-section">
      <SectionHeading>Changelog</SectionHeading>

      <SectionCard
        id="changelog"
        title="Commit History"
        description="Recent commits and changes to the platform."
      >
        {loading && (
          <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '12px 0' }}>
            Loading changelog...
          </div>
        )}

        {error && (
          <div style={{ fontSize: 13, color: 'var(--status-error, #ef4444)', padding: '12px 0' }}>
            {error}
          </div>
        )}

        {!loading && !error && commits.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '8px 0' }}>
            No changelog entries found.
          </div>
        )}

        {!loading && !error && commits.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {Array.from(grouped.entries()).map(([date, dateCommits]) => (
              <div key={date}>
                <div style={{
                  fontSize: 12, fontWeight: 600, color: 'var(--text-muted)',
                  marginBottom: 8, paddingBottom: 4,
                  borderBottom: '1px solid var(--border-color)',
                }}>
                  {formatDate(date)}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {dateCommits.map(commit => (
                    <div
                      key={commit.hash}
                      data-testid={`changelog-commit-${commit.shortHash}`}
                      style={{
                        display: 'flex', alignItems: 'flex-start', gap: 10,
                        padding: '6px 10px', borderRadius: 6,
                        background: 'var(--bg-secondary)',
                      }}
                    >
                      <span style={{
                        fontFamily: 'var(--font-mono)', fontSize: 11,
                        color: 'var(--text-muted)', flexShrink: 0,
                        marginTop: 2,
                      }}>
                        {commit.shortHash}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                            {commit.title}
                          </span>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
                            {commit.author}
                          </span>
                        </div>
                        {commit.body && (
                          <div style={{
                            fontSize: 12, color: 'var(--text-muted)',
                            marginTop: 2, lineHeight: 1.4,
                            whiteSpace: 'pre-wrap',
                          }}>
                            {commit.body}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {hasMore && (
              <div style={{ textAlign: 'center', paddingTop: 4 }}>
                <button
                  className="btn btn-sm"
                  onClick={() => fetchChangelog(nextOffset, true)}
                  disabled={loadingMore}
                  data-testid="changelog-load-more"
                >
                  {loadingMore ? 'Loading...' : 'Load More'}
                </button>
              </div>
            )}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
