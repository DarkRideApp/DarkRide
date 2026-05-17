import { useCallback, useEffect, useState } from 'react';
import { useWebSocket } from './useWebSocket';
import type { AiTier } from './ai-tier-types';

export function useAiTiers() {
  const { sendRestApi } = useWebSocket();
  const [tiers, setTiers] = useState<AiTier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await sendRestApi('GET', '/v1/ai/tiers');
      if (res.status === 200 && Array.isArray(res.body)) {
        setTiers(res.body as AiTier[]);
        setError(null);
      } else {
        setError('Failed to load tiers');
      }
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  }, [sendRestApi]);

  useEffect(() => { refresh(); }, [refresh]);

  return { tiers, loading, error, refresh };
}
