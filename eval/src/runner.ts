/**
 * Main eval runner — orchestrates: load cases → agent fix → grade.
 *
 * The agent harness (runAgentFix) manages its own E2B sandbox for fix generation.
 * A local sandbox is still used for test grading (FAIL_TO_PASS / PASS_TO_PASS).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile as execFileCb } from 'node:child_process';
import { loadAllCases, loadGoldPatch } from './loader.js';
import { createSandbox, destroySandbox } from './sandbox.js';
import { callPipeline } from './pipeline-caller.js';
import { runTests } from './test-executor.js';
import { gradeCase } from './grader.js';
import { judgeCase } from './judge.js';
import { validateDiffPaths } from '../../packages/worker/src/repo-clone.js';
import { extractStackTraceFiles } from '../../packages/worker/src/harness/stack-trace-utils.js';
import { initTracing, shutdownTracing, traceSpan } from '../../packages/worker/src/tracing.js';
import type { EvalCase, EvalCaseResult, JudgeResult } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CASES_DIR = path.join(ROOT, 'cases');
const APPS_DIR = path.join(ROOT, 'apps');

/**
 * Normalize a unified diff so git apply doesn't choke on format quirks.
 * - Blank lines inside hunks get a leading space (context line marker).
 * - Trailing whitespace on diff lines is stripped.
 * - Ensures trailing newline.
 */
function normalizeDiff(raw: string): string {
  // Strip \r globally (E2B may return \r\n), then split
  const lines = raw.replace(/\r/g, '').split('\n');
  // Remove the trailing empty string that split() creates when input ends with \n.
  // Without this, the empty string gets treated as a blank context line inside the
  // last hunk, inflating the line count and causing "corrupt patch".
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  let inHunk = false;
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith('@@')) {
      inHunk = true;
      out.push(line);
    } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('new file') || line.startsWith('deleted file')) {
      inHunk = false;
      out.push(line);
    } else if (inHunk && line.trim() === '') {
      // Blank line inside a hunk = context line that lost its leading space
      out.push(' ');
    } else if (inHunk) {
      out.push(line.replace(/\s+$/, ''));
    } else {
      out.push(line);
    }
  }
  return out.join('\n') + '\n';
}

/** Pipe a diff string to git apply via stdin. */
function gitApplyStdin(cwd: string, diff: string): Promise<void> {
  const normalized = normalizeDiff(diff);
  return new Promise<void>((resolve, reject) => {
    const child = execFileCb(
      'git', ['apply', '--whitespace=fix'],
      { cwd, timeout: 30_000 },
      (error) => {
        if (error) {
          reject(new Error(`git apply failed: ${error.message}`));
          return;
        }
        resolve();
      }
    );
    if (child.stdin) {
      child.stdin.write(normalized);
      child.stdin.end();
    }
  });
}

async function runCase(evalCase: EvalCase): Promise<EvalCaseResult> {
  const start = Date.now();
  let sandboxPath: string | null = null;

  try {
    // Call agent harness — fix generation happens in E2B sandbox
    const result = await callPipeline(evalCase, CASES_DIR);

    let patchApplied = false;
    let f2pResults: Awaited<ReturnType<typeof runTests>> = [];
    let p2pResults: Awaited<ReturnType<typeof runTests>> = [];

    if (result.status === 'fix_ready' && result.diff) {
      // Create local sandbox for test grading
      const appDir = path.join(APPS_DIR, evalCase.app);
      const patchPath = evalCase.bug_patch
        ? path.join(CASES_DIR, evalCase.id, evalCase.bug_patch)
        : null;
      sandboxPath = await createSandbox(appDir, patchPath);

      if (process.env['EVAL_DEBUG']) {
        console.log(`  DEBUG diff (${result.diff.length} chars):\n${result.diff}`);
      }

      // Validate diff paths before applying
      const pathCheck = validateDiffPaths(result.diff);
      if (!pathCheck.valid) {
        console.log(`  WARN: diff path validation failed: ${pathCheck.error}`);
        patchApplied = false;
      } else {
        try {
          await gitApplyStdin(sandboxPath, result.diff);
          patchApplied = true;
        } catch (applyErr: unknown) {
          const msg = applyErr instanceof Error ? applyErr.message : String(applyErr);
          console.log(`  WARN: git apply failed: ${msg}`);
          patchApplied = false;
        }
      }

      if (patchApplied) {
        f2pResults = await runTests(sandboxPath, evalCase.grading.fail_to_pass);
        p2pResults = await runTests(sandboxPath, evalCase.grading.pass_to_pass);
      }
    }

    // LLM-as-judge quality assessment (only for fix_pr with diff)
    let judgeResult: JudgeResult | undefined;
    let judgeSkipped = false;
    if (result.status === 'fix_ready' && result.diff && evalCase.expected.outcome === 'fix_pr') {
      const goldPatch = await loadGoldPatch(path.join(CASES_DIR, evalCase.id));
      const stackTraceFiles = extractStackTraceFiles(evalCase.error_event.error.stack);
      try {
        judgeResult = await judgeCase(evalCase, result.diff, goldPatch, stackTraceFiles);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  WARN: judge failed: ${msg}`);
        judgeSkipped = true;
      }
    }

    return gradeCase(evalCase, result, patchApplied, f2pResults, p2pResults, Date.now() - start, judgeResult, judgeSkipped);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      case_id: evalCase.id,
      passed: false,
      outcome_correct: false,
      actual_outcome: 'error',
      duration_ms: Date.now() - start,
      error_message: message,
    };
  } finally {
    if (sandboxPath) {
      await destroySandbox(sandboxPath);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const jsonOutput = args.includes('--json');
  const filterArg = args.find(a => a.startsWith('--filter='));
  const filter = filterArg?.split('=')[1];

  console.log('Loading eval cases...');
  let cases = await loadAllCases(CASES_DIR);

  if (filter) {
    cases = cases.filter(c => c.id.includes(filter));
  }

  console.log(`Found ${cases.length} cases${filter ? ` (filtered by "${filter}")` : ''}`);

  if (dryRun) {
    for (const c of cases) {
      console.log(`  ${c.id} [${c.expected.outcome}] ${c.metadata.difficulty} ${c.metadata.category}`);
    }
    console.log(`\n${cases.length} cases loaded successfully.`);
    return;
  }

  // Preflight: fail fast if required keys are missing
  if (!process.env['ANTHROPIC_API_KEY']) {
    console.error('ERROR: ANTHROPIC_API_KEY is not set. Required for agent harness.');
    console.error('Set it with: ANTHROPIC_API_KEY=sk-ant-... pnpm eval');
    process.exit(1);
  }

  // Initialize tracing so agent harness spans are exported to Langfuse
  await initTracing();

  let passed = 0;
  const results: EvalCaseResult[] = [];

  try {
    for (const evalCase of cases) {
      console.log(`\nRunning: ${evalCase.id} (${evalCase.metadata.category})...`);
      const result = await traceSpan(
        'eval-case',
        {
          'eval.case_id': evalCase.id,
          'eval.category': evalCase.metadata.category,
          'eval.difficulty': evalCase.metadata.difficulty,
          'eval.expected_outcome': evalCase.expected.outcome,
        },
        () => runCase(evalCase),
      );
      results.push(result);
      if (result.passed) passed++;
      const icon = result.passed ? 'PASS' : result.error_message ? 'ERROR' : 'FAIL';
      const qualityInfo = result.judge_result
        ? ` quality:${result.judge_result.quality_passed ? 'PASS' : 'FAIL'}(${result.judge_result.total}/6) scope:${result.judge_result.scope} correct:${result.judge_result.correctness} preserve:${result.judge_result.preservation}`
        : result.judge_skipped ? ' quality:SKIPPED' : '';
      console.log(`  ${icon} (${result.duration_ms}ms)${qualityInfo}${result.error_message ? `: ${result.error_message}` : ''}`);
      if (result.judge_result && !result.judge_result.quality_passed) {
        console.log(`    → ${result.judge_result.explanation}`);
      }
    }

    console.log('\n=== EVAL SUMMARY ===');
    const judgeSkippedCount = results.filter(r => r.judge_skipped).length;
    console.log(`${passed}/${results.length} passed${judgeSkippedCount > 0 ? ` (${judgeSkippedCount} judge-skipped)` : ''}`);

    if (jsonOutput) {
      console.log(JSON.stringify(results, null, 2));
    }

    if (passed < results.length) {
      process.exit(1);
    }
  } finally {
    // Flush pending spans to Langfuse before exit
    await shutdownTracing();
  }
}

main().catch(err => {
  console.error('Eval runner failed:', err);
  process.exit(1);
});
