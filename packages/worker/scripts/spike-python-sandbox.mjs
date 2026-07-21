// Batch 0 spike (#86): measure E2B Python sandbox boot, pip install for the
// complete fixture Flask app, and the pytest gate Batch 3 will run.
// Findings gate Batch 3's 300s install budget.
// Run from packages/worker with the SAME E2B_API_KEY the production worker
// uses — this doubles as the template-ownership check (names are team-local).
import { Sandbox } from 'e2b';
import { readFileSync } from 'node:fs';

const TEMPLATE = 'opslane-python';
const FIXTURE = new URL('../../../test-fixtures/flask-app/', import.meta.url);
const FILES = ['app.py', 'requirements.txt', 'tests/test_health.py'];

let sbx;
try {
  const t0 = Date.now();
  // Lifetime must exceed the longest command timeout below (600s).
  sbx = await Sandbox.create(TEMPLATE, { timeoutMs: 900_000 });
  console.log(`sandbox boot: ${Date.now() - t0}ms`);

  await sbx.commands.run('mkdir -p /home/user/fixture/tests');
  for (const file of FILES) {
    await sbx.files.write(
      `/home/user/fixture/${file}`,
      readFileSync(new URL(file, FIXTURE), 'utf8'),
    );
  }

  const t1 = Date.now();
  await sbx.commands.run(
    'cd /home/user/fixture && pip install --no-cache-dir -r requirements.txt',
    { timeoutMs: 600_000 },
  );
  console.log(`pip install: ${Date.now() - t1}ms`);

  for (const command of [
    'python -c "import flask, sqlalchemy, psycopg2; print(\'imports ok\')"',
    'cd /home/user/fixture && python -c "import app; print(\'app ok\')"',
    'python -m pytest --version',
    'xz --version',
    'cd /home/user/fixture && python -m pytest -v --junit-xml=/tmp/opslane-junit.xml',
    'python -c "from pathlib import Path; p=Path(\'/tmp/opslane-junit.xml\'); assert p.read_text().startswith(\'<?xml\'); print(\'junit xml readable\')"',
  ]) {
    const result = await sbx.commands.run(command, { timeoutMs: 120_000 });
    const stderr = result.stderr ? `\n${result.stderr.trim()}` : '';
    console.log(`$ ${command}\n${result.stdout.trim()}${stderr}`);
  }
  console.log('SPIKE PASSED');
} catch (error) {
  // CommandExitError carries stdout/stderr/exitCode from the failed command.
  console.error('SPIKE FAILED:', error?.message ?? error);
  if (error?.stderr) console.error(String(error.stderr).slice(-3_000));
  process.exitCode = 1;
} finally {
  await sbx?.kill();
}
