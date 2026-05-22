import * as core from '@actions/core';

type DriftRow = {
  id: string;
  taskId: string;
  severity: string;
  taskBoundVersion: number;
  currentPlanVersion: number;
  reason?: string;
  task?: { title?: string };
};

type DriftsResponse = { data?: DriftRow[] };

export async function run() {
  try {
    const apiUrl = core.getInput('api-url').replace(/\/$/, '');
    const apiKey = core.getInput('api-key');
    const projectId = core.getInput('project');

    // Mask the api-key so it never appears in GitHub Actions logs even when
    // accidentally echoed (e.g. via `set -x`, child process stderr, or a
    // contributor adding `core.debug(headers)` later). `setSecret` is a no-op
    // when the value is empty, so it is safe to call unconditionally.
    if (apiKey) {
      core.setSecret(apiKey);
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };

    const res = await fetch(`${apiUrl}/api/projects/${projectId}/drifts?status=open&pageSize=100`, {
      headers,
    });

    const json = (await res.json()) as DriftsResponse & { error?: { message?: string } };

    if (!res.ok) {
      core.setFailed(json?.error?.message || `HTTP ${res.status} ${res.statusText}`);
      return;
    }

    const drifts = json.data ?? [];

    if (drifts.length === 0) {
      core.info('No open drift alerts');
      core.setOutput('drift-count', '0');
      core.setOutput('has-drift', 'false');
      return;
    }

    core.warning(`Found ${drifts.length} open drift alert(s)`);
    for (const drift of drifts) {
      const title = drift.task?.title ? ` "${drift.task.title}"` : '';
      const msg = `Drift${title}: task ${drift.taskId} bound to plan v${drift.taskBoundVersion} (active is v${drift.currentPlanVersion}) — severity: ${drift.severity}`;
      if (drift.severity === 'high') {
        core.error(msg);
      } else {
        core.warning(msg);
      }
    }

    core.setOutput('drift-count', String(drifts.length));
    core.setOutput('has-drift', 'true');

    const hasHigh = drifts.some((d) => d.severity === 'high');
    if (hasHigh) {
      core.setFailed('High severity drift detected');
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(message);
  }
}

// When this module is the GitHub Action entrypoint, kick off `run()`
// immediately. During unit tests we import `run` directly and drive it from
// the test runner, so we suppress auto-invocation via VITEST.
if (!process.env.VITEST) {
  void run();
}
