'use client';

import { useState, useEffect, useCallback } from 'react';

type ProjectResponse = {
  data: {
    id: string;
    name: string;
    description: string | null;
    phase: string;
    repoUrl: string | null;
    defaultBranch: string | null;
    createdBy: string;
    createdAt: string;
    updatedAt: string;
    _count: { members: number; plans: number; tasks: number };
    activePlanVersion: number | null;
    taskStats: Record<string, number>;
  };
};

export function useProject(projectId: string) {
  const [data, setData] = useState<ProjectResponse['data'] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const message =
          typeof body?.error?.message === 'string'
            ? body.error.message
            : `Request failed (${res.status})`;
        throw new Error(message);
      }
      const json = (await res.json()) as ProjectResponse;
      setData(json.data);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      setData(null);
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { data, error, isLoading, refetch };
}
