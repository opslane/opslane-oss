-- 014_verification_evidence.sql
-- Evidence-tiered verification (Phase 0): persist the structured evidence
-- record and the candidate diff so needs_human writeups show their proof.
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS verification_evidence JSONB;
ALTER TABLE error_groups ADD COLUMN IF NOT EXISTS candidate_diff TEXT;
