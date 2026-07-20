import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

import { closePool, getEnvironmentNamesForGroup } from '../db.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('environment context integration', () => {
  let pool: pg.Pool;
  let orgId: string;
  let projectId: string;
  let otherProjectId: string;
  let productionId: string;
  let stagingId: string;
  let errorGroupId: string;
  let frictionGroupId: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const org = await pool.query<{ id: string }>(
      `INSERT INTO orgs (name) VALUES ($1) RETURNING id`,
      [`worker-environment-context-${crypto.randomUUID()}`],
    );
    orgId = org.rows[0]!.id;

    const projects = await pool.query<{ id: string }>(
      `INSERT INTO projects (org_id, name, github_repo, default_branch)
       VALUES ($1, 'context-project', 'example/context', 'main'),
              ($1, 'other-project', 'example/other', 'main')
       RETURNING id`,
      [orgId],
    );
    projectId = projects.rows[0]!.id;
    otherProjectId = projects.rows[1]!.id;

    const environments = await pool.query<{ id: string; name: string }>(
      `INSERT INTO environments (project_id, name)
       VALUES ($1, 'production'),
              ($1, 'staging')
       RETURNING id, name`,
      [projectId],
    );
    productionId = environments.rows.find((row) => row.name === 'production')!.id;
    stagingId = environments.rows.find((row) => row.name === 'staging')!.id;

    const errorGroup = await pool.query<{ id: string }>(
      `INSERT INTO error_groups
         (project_id, fingerprint, title, first_seen, last_seen, status, kind)
       VALUES ($1, $2, 'Context error', now(), now(), 'queued', 'error')
       RETURNING id`,
      [projectId, `context-error-${crypto.randomUUID()}`],
    );
    errorGroupId = errorGroup.rows[0]!.id;

    await pool.query(
      `INSERT INTO error_group_environments
         (error_group_id, environment_id, first_seen, last_seen, occurrence_count)
       VALUES ($1, $2, now(), now(), 1),
              ($1, $3, now(), now(), 1)`,
      [errorGroupId, productionId, stagingId],
    );

    const frictionGroup = await pool.query<{ id: string }>(
      `INSERT INTO error_groups
         (project_id, environment_id, fingerprint, title, first_seen, last_seen, status, kind)
       VALUES ($1, $2, $3, 'Context friction', now(), now(), 'queued', 'friction')
       RETURNING id`,
      [projectId, productionId, `context-friction-${crypto.randomUUID()}`],
    );
    frictionGroupId = frictionGroup.rows[0]!.id;

    // A stale/legacy rollup row must not broaden friction context.
    await pool.query(
      `INSERT INTO error_group_environments
         (error_group_id, environment_id, first_seen, last_seen, occurrence_count)
       VALUES ($1, $2, now(), now(), 1)`,
      [frictionGroupId, stagingId],
    );
  });

  afterAll(async () => {
    if (orgId) {
      await pool.query(
        `DELETE FROM error_group_environments
         WHERE error_group_id IN ($1, $2)`,
        [errorGroupId, frictionGroupId],
      );
      await pool.query(`DELETE FROM error_groups WHERE project_id = $1`, [projectId]);
      await pool.query(`DELETE FROM environments WHERE project_id = $1`, [projectId]);
      await pool.query(`DELETE FROM projects WHERE org_id = $1`, [orgId]);
      await pool.query(`DELETE FROM orgs WHERE id = $1`, [orgId]);
    }
    await pool?.end();
    await closePool();
  });

  it('uses the rollup for errors, the direct environment for friction, and project scope for both', async () => {
    await expect(getEnvironmentNamesForGroup(errorGroupId, projectId, 'error')).resolves.toEqual({
      names: ['production', 'staging'],
      totalCount: 2,
    });
    await expect(getEnvironmentNamesForGroup(frictionGroupId, projectId, 'friction')).resolves.toEqual({
      names: ['production'],
      totalCount: 1,
    });
    await expect(getEnvironmentNamesForGroup(errorGroupId, otherProjectId, 'error')).resolves.toEqual({
      names: [],
      totalCount: 0,
    });
    await expect(getEnvironmentNamesForGroup(frictionGroupId, otherProjectId, 'friction')).resolves.toEqual({
      names: [],
      totalCount: 0,
    });
  });
});
