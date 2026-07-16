import type pg from 'pg';

const TYPE_TITLES: Record<string, string> = {
  rage_click: 'rage clicks',
  dead_click: 'dead clicks',
  form_abandon: 'form abandonment',
};

/**
 * Dead-letter reconciliation for a session_analysis job (plan D5 / issue #56).
 * Runs INSIDE the caller's dead-letter transaction so the job flip, signal
 * flips, generation release, and diagnostic upserts commit atomically:
 *
 * - Every still-pending signal claimed by the job becomes 'unchecked' —
 *   never folds, never counts toward threshold, never fix-eligible.
 *   Accepted/rejected signals are untouched.
 * - Any in-flight generation owned by the job becomes terminal 'unchecked',
 *   releasing the partial-unique in-flight slot for a later generation.
 *   claim_job_id is preserved for audit.
 * - One visible diagnostic candidate per exhausted adjudication, keyed by
 *   the adjudication's own identity — 'friction-unchecked:<generation-id>'
 *   for bucket calls, 'friction-unchecked:<signal-id>' for eager fold calls —
 *   so it can never collide with the promotable 'friction:<env>:<fp>' key.
 *   Diagnostics carry zero impact, no junctions, and no jobs; their
 *   non-'awaiting_approval' status keeps TriggerFix impossible.
 */
export async function reconcileDeadLetteredSessionAnalysis(
  client: pg.PoolClient,
  jobId: string,
  projectId: string,
): Promise<void> {
  const signals = await client.query<{
    id: string;
    environment_id: string;
    fingerprint: string;
    signal_type: string;
    page_url_normalized: string;
    element_selector: string | null;
  }>(
    `UPDATE friction_signals
     SET adjudication_status = 'unchecked', adjudicated_at = now()
     WHERE adjudication_job_id = $1 AND project_id = $2
       AND adjudication_status = 'pending'
     RETURNING id, environment_id, fingerprint, signal_type,
               page_url_normalized, element_selector`,
    [jobId, projectId],
  );
  const generations = await client.query<{
    id: string;
    environment_id: string;
    fingerprint: string;
  }>(
    `UPDATE friction_adjudication_generations
     SET status = 'unchecked', finished_at = now()
     WHERE claim_job_id = $1 AND project_id = $2 AND status = 'adjudicating'
     RETURNING id, environment_id, fingerprint`,
    [jobId, projectId],
  );

  async function upsertDiagnostic(
    fingerprint: string,
    environmentId: string,
    descriptor: { signal_type?: string; page_url_normalized?: string; element_selector?: string | null },
  ): Promise<string> {
    const kind = TYPE_TITLES[descriptor.signal_type ?? ''] ?? 'friction';
    const title = `Unchecked friction: ${kind} on ${descriptor.page_url_normalized ?? 'unknown page'}`;
    await client.query(
      `INSERT INTO error_groups
         (project_id, environment_id, fingerprint, title, first_seen, last_seen,
          occurrence_count, affected_users_count, status, kind, adjudication_status,
          signal_type, page_url_normalized, element_selector)
       VALUES ($1, $2, $3, $4, now(), now(), 0, 0, 'candidate', 'friction', 'unchecked',
               $5, $6, $7)
       ON CONFLICT (project_id, fingerprint) DO NOTHING`,
      [
        projectId,
        environmentId,
        fingerprint,
        title,
        descriptor.signal_type ?? null,
        descriptor.page_url_normalized ?? null,
        descriptor.element_selector ?? null,
      ],
    );
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM error_groups WHERE project_id = $1 AND fingerprint = $2`,
      [projectId, fingerprint],
    );
    return rows[0]!.id;
  }

  const generationTuples = new Set<string>();
  for (const gen of generations.rows) {
    generationTuples.add(`${gen.environment_id}|${gen.fingerprint}`);
    const representative = signals.rows.find(
      (s) => s.environment_id === gen.environment_id && s.fingerprint === gen.fingerprint,
    );
    const diagnosticId = await upsertDiagnostic(
      `friction-unchecked:${gen.id}`,
      gen.environment_id,
      representative ?? {},
    );
    await client.query(
      `UPDATE friction_adjudication_generations SET diagnostic_incident_id = $2 WHERE id = $1`,
      [gen.id, diagnosticId],
    );
  }
  // Signals claimed for eager fold attempts (no owning generation) get
  // signal-scoped diagnostics.
  for (const sig of signals.rows) {
    if (generationTuples.has(`${sig.environment_id}|${sig.fingerprint}`)) continue;
    await upsertDiagnostic(`friction-unchecked:${sig.id}`, sig.environment_id, sig);
  }
}
