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

async function run() {
  try {
    const apiUrl = core.getInput('api-url').replace(/\/$/, '');
    const apiKey = core.getInput('api-key');
    const projectId = core.getInput('project');

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

void run();
