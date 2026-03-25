import { describe, it, expect, beforeEach } from 'vitest';
import { Parallax } from '../src/parallax.js';

describe('relations and DAG validation', () => {
  let p: Parallax;
  let agentId: string;
  let runId: string;

  beforeEach(async () => {
    p = new Parallax();
    const agent = await p.createAgent({ type: 'Agent', properties: {} });
    agentId = agent.id;
    const run = await p.createRun(agentId);
    runId = run.id;
  });

  it('dependency graph DAG validation rejects cycles', async () => {
    const art1 = await p.createArtifact({
      type: 'data',
      producedByActionId: 'ext',
      runId,
      content: { v: 1 },
      reusable: false,
      properties: {},
    });

    const art2 = await p.createArtifact({
      type: 'data',
      producedByActionId: 'ext',
      runId,
      content: { v: 2 },
      reusable: false,
      properties: {},
    });

    // art1 -> art2
    await p.link('DEPENDS_ON', art1.id, art2.id);

    // art2 -> art1 would create a cycle
    await expect(p.link('DEPENDS_ON', art2.id, art1.id)).rejects.toThrow(
      /cycle/i,
    );
  });

  it('rejects relations referencing missing objects', async () => {
    const art = await p.createArtifact({
      type: 'data',
      producedByActionId: 'ext',
      runId,
      content: { v: 1 },
      reusable: false,
      properties: {},
    });

    await expect(p.link('DEPENDS_ON', art.id, 'nonexistent')).rejects.toThrow(
      /not found/i,
    );
  });
});
