-- Deterministic onboarding-reporting seed. Apply scripts/seed-e2e.sql first.
--
-- Raw development API key: e2e-development-key-plaintext
-- Raw poll token: opt_9001e986d7d75a0051a2e832119dc17b3aec0390e8d1b986b0c2212fbc23cb5c
--
-- Matching pending file (~/.opslane/pending/00000000-0000-4000-8000-00000000a001.json):
-- {"poll_id":"00000000-0000-4000-8000-00000000a001","poll_token":"opt_9001e986d7d75a0051a2e832119dc17b3aec0390e8d1b986b0c2212fbc23cb5c","api_url":"http://localhost:8082","repo":"opslane/defender-test-fixture","created_at":"2026-07-21T00:00:00.000Z"}

INSERT INTO environments (id, project_id, name) VALUES
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000010', 'development')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

-- key_hash is SHA256 of the raw key "e2e-development-key-plaintext".
INSERT INTO environment_api_keys (id, environment_id, key_hash, key_prefix) VALUES
  ('00000000-0000-0000-0000-000000001001', '00000000-0000-0000-0000-000000000101',
   '508823bf8ff4d9f79476e49235816b554864b5fdc65f1c4a7e7abf58e24e397d', 'e2e-dev-')
ON CONFLICT (id) DO UPDATE SET
  environment_id = EXCLUDED.environment_id,
  key_hash = EXCLUDED.key_hash,
  revoked_at = NULL;

INSERT INTO agent_sessions (
  id, repo_url, status, org_id, project_id, poll_token_hash, agent_key_pub,
  api_key_sealed, expires_at, completed_at, key_claimed_at, failure_reason
) VALUES (
  '00000000-0000-4000-8000-00000000a001',
  'opslane/defender-test-fixture',
  'provisioned',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000010',
  '1dd1432510c1f0541b2e3aeb3cc70e35766471c7e3859c8e370f47194da988e6',
  '9cjjJ7AOfdXVKfWwI3CsBHLxOf1YvmCOh+/V/KAG8Qk=',
  'UhFCFG9oy9a5zir6ph2y/RW7VUxCr8+WAUOG3biuKHB/UTyXaKHDRzGr/DtR/tvbro6VXhW7lu1Gw9yGbUTsnHlHY5JLIh6JaNx5aRmwP2lgWgWXJ/wFORo=',
  now() + interval '24 hours',
  NULL,
  NULL,
  NULL
)
ON CONFLICT (id) DO UPDATE SET
  status = 'provisioned',
  org_id = EXCLUDED.org_id,
  project_id = EXCLUDED.project_id,
  poll_token_hash = EXCLUDED.poll_token_hash,
  agent_key_pub = EXCLUDED.agent_key_pub,
  api_key_sealed = EXCLUDED.api_key_sealed,
  expires_at = EXCLUDED.expires_at,
  completed_at = NULL,
  key_claimed_at = NULL,
  failure_reason = NULL;
