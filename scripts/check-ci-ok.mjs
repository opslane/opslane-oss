#!/usr/bin/env node
/**
 * The ci-ok gate.
 *
 * Replaces the old blanket `contains(needs.*.result, 'skipped')` condition.
 * That condition was a real guard -- it stopped a job that silently vanished
 * from passing -- so introducing path filtering must not simply allow skips.
 * Instead this checks every job against what the `changes` classifier said
 * should happen, in BOTH directions:
 *
 *   expected to run  -> result must be exactly 'success'
 *   expected to skip -> result must be exactly 'skipped'
 *
 * The second direction catches drift: a job whose `if:` no longer matches the
 * area it gates on gets flagged instead of quietly passing.
 *
 * Consumes toJSON(needs) via $NEEDS. `needs` outputs are strings, so "false"
 * is truthy in JS -- every check compares exact literals and treats anything
 * else, including missing and empty, as a hard failure. fromJSON is avoided
 * deliberately: it throws on an empty output.
 *
 * Usage: NEEDS='${{ toJSON(needs) }}' node scripts/check-ci-ok.mjs
 */

/** job id in ci.yml -> the classifier output that gates it. */
export const GATED = {
  go: 'go',
  js: 'js',
  'sdk-python': 'python',
  'e2e-keyless': 'e2e',
  'reliability-system': 'reliability',
};

/** Job ids that must always run and always succeed. */
export const ALWAYS = ['changes', 'repo-checks', 'compose', 'security'];

export function verify(needs) {
  const problems = [];

  if (needs === null || typeof needs !== 'object' || Array.isArray(needs)) {
    return ['NEEDS must be a JSON object'];
  }

  const changes = needs.changes;
  if (!changes) return ['needs is missing the `changes` job -- add it to ci-ok.needs'];
  if (changes.result !== 'success') {
    // Without a trustworthy classification, no skip can be justified.
    return [`\`changes\` did not succeed (result: ${changes.result}); refusing to interpret any skip`];
  }

  const known = new Set([...Object.keys(GATED), ...ALWAYS]);
  for (const job of Object.keys(needs)) {
    if (!known.has(job)) {
      problems.push(
        `job \`${job}\` is in ci-ok.needs but check-ci-ok.mjs does not know it -- add it to GATED or ALWAYS`,
      );
    }
  }

  for (const job of ALWAYS) {
    if (job === 'changes') continue;
    const result = needs[job]?.result;
    if (result === undefined) problems.push(`always-on job \`${job}\` is missing from needs`);
    else if (result !== 'success') problems.push(`always-on job \`${job}\` must succeed (result: ${result})`);
  }

  const outputs = changes.outputs ?? {};
  for (const [job, area] of Object.entries(GATED)) {
    const raw = outputs[area];
    if (raw !== 'true' && raw !== 'false') {
      problems.push(
        `the \`changes\` output for area \`${area}\` must be the literal "true" or "false" (got: ${JSON.stringify(raw)})`,
      );
      continue;
    }
    const result = needs[job]?.result;
    if (result === undefined) {
      problems.push(`gated job \`${job}\` is missing from needs`);
      continue;
    }
    if (raw === 'true' && result !== 'success') {
      problems.push(`job \`${job}\` was expected to run (${area}=true) but its result was ${result}`);
    }
    if (raw === 'false' && result !== 'skipped') {
      problems.push(
        `job \`${job}\` was expected to skip (${area}=false) but its result was ${result} -- the job's if: and the classifier disagree`,
      );
    }
  }

  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const raw = process.env.NEEDS;
  if (!raw) {
    console.error('NEEDS is not set');
    process.exit(1);
  }
  let needs;
  try {
    needs = JSON.parse(raw);
  } catch (error) {
    console.error(`NEEDS is not valid JSON: ${error.message}`);
    process.exit(1);
  }
  const problems = verify(needs);
  if (problems.length > 0) {
    console.error('ci-ok failed:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log('ci-ok: every job ran or skipped exactly as the changed-file classification required.');
}
