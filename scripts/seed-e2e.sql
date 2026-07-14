-- scripts/seed-e2e.sql
-- Idempotent seed for E2E testing. Run against Opslane DB.
--
-- Usage:
--   PGPASSWORD=opslane_dev psql -h localhost -p 5434 -U opslane -d opslane -f scripts/seed-e2e.sql
--
-- Test API key (raw): e2e-test-key-plaintext
-- SHA256 hash: 9593bc5c8575550af4065fbb43886b3a5443273976ca27b78cfa991d6e777279

INSERT INTO orgs (id, name) VALUES
  ('00000000-0000-0000-0000-000000000001', 'E2E Test Org')
ON CONFLICT (id) DO NOTHING;

INSERT INTO projects (id, org_id, name, github_repo, default_branch) VALUES
  ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001',
   'Opslane Test Fixture', 'opslane/opslane-test-fixture', 'main')
ON CONFLICT (id) DO NOTHING;

INSERT INTO environments (id, project_id, name) VALUES
  ('00000000-0000-0000-0000-000000000100', '00000000-0000-0000-0000-000000000010', 'production')
ON CONFLICT (id) DO NOTHING;

-- key_hash is SHA256 of the raw key "e2e-test-key-plaintext"
INSERT INTO environment_api_keys (id, environment_id, key_hash, key_prefix) VALUES
  ('00000000-0000-0000-0000-000000001000', '00000000-0000-0000-0000-000000000100',
   '9593bc5c8575550af4065fbb43886b3a5443273976ca27b78cfa991d6e777279', 'e2e-')
ON CONFLICT (id) DO UPDATE SET key_hash = EXCLUDED.key_hash;

-- Test user for auth E2E (password: testpassword123, bcrypt cost 10)
INSERT INTO users (id, org_id, email, password_hash, name) VALUES
  ('00000000-0000-0000-0000-000000010000', '00000000-0000-0000-0000-000000000001',
   'admin@e2e.test', '$2b$10$G63dr4R.8EijgojPPTsQ8uC0hdGaPvtQ4UiSqj9Nbi0DH0Wh/xgi2', 'E2E Admin')
ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash;

-- Test user for dashboard auth (password: defender123, bcrypt cost 10)
INSERT INTO users (id, org_id, email, password_hash, name) VALUES
  ('00000000-0000-0000-0000-000000020000', '00000000-0000-0000-0000-000000000001',
   'test@opslane.dev', '$2a$10$ke5hsybfrQnnbUqXdRmd9uyOS5rJNHlv1iegB0d9kVVO4N/O66ag6', 'Test User')
ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash;
