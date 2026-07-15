import { getPool, type SessionRow } from '../db.js';
import type { DetectedSignal } from './analyzer.js';

/** Writes one whole-session analysis pass at a single rule version. */
export async function writeFrictionSignals(
  session: SessionRow,
  signals: DetectedSignal[],
  ruleVersion: number,
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    for (const signal of signals) {
      await client.query(
        `INSERT INTO friction_signals
           (session_id, project_id, environment_id, end_user_id, rule_version,
            signal_type, fingerprint, element_selector, page_url_normalized,
            occurred_at, occurrence_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10 / 1000.0),$11)
         ON CONFLICT (session_id, fingerprint, rule_version)
         DO UPDATE SET occurrence_count = EXCLUDED.occurrence_count,
                       occurred_at = EXCLUDED.occurred_at,
                       retracted_at = NULL`,
        [
          session.id,
          session.project_id,
          session.environment_id,
          session.end_user_id,
          ruleVersion,
          signal.signalType,
          signal.fingerprint,
          signal.elementSelector,
          signal.pageUrlNormalized,
          signal.occurredAt,
          signal.occurrenceCount,
        ],
      );
    }

    await client.query(
      `UPDATE friction_signals SET retracted_at = now()
       WHERE session_id = $1 AND project_id = $2 AND rule_version = $3
         AND retracted_at IS NULL AND superseded_by IS NULL
         AND fingerprint <> ALL($4::text[])`,
      [session.id, session.project_id, ruleVersion, signals.map((signal) => signal.fingerprint)],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
