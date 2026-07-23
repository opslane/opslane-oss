#!/usr/bin/env node
// Detect-stage eval (Phase 1, Task 1.8).
//
// Runs the READ-ONLY detect stage against real repos and prints the plan it reports.
// The agent has tools Read + Glob + our secret-aware `search` + `report_plan` — and NO
// Edit/Write/Bash tools at all, so it is physically incapable of changing the target
// repos. That makes it safe to run against clones in place (no copy needed).
//
//   export ANTHROPIC_API_KEY=...           # e.g. from ~/Projects/opslane/opslane-oss/.env
//   pnpm --filter @opslane/cli build       # this script imports cli/dist
//   node cli/scripts/detect-eval.mjs <repoA> <repoB> ...
//
// This spike inlines the detect prompt and the report_plan tool. Once the Detect stage
// lands as real code (renderDetectSpec + createReportPlanTool + runDetect), point this at
// those exports instead of the inlined copies below.

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '..');                       // cli/ — resolves the bare SDK/zod specifiers
const req = createRequire(`${CLI}/`);
const sdk = await import(pathToFileURL(req.resolve('@anthropic-ai/claude-agent-sdk')).href);
const { query, tool, createSdkMcpServer } = sdk;
const { z } = await import(pathToFileURL(req.resolve('zod')).href);
const dist = async (m) => import(pathToFileURL(resolve(CLI, 'dist/onboard', m)).href);
const { createSearchTool } = await dist('search-tool.js');
const { createAskUserTool } = await dist('tools.js');
const { onboardPreToolUseHook } = await dist('policy.js');

const roots = process.argv.slice(2).map((p) => resolve(p));
if (roots.length === 0) { console.error('usage: detect-eval.mjs <repoA> <repoB> ...'); process.exit(1); }
if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1); }

const DETECT_PROMPT = (root) => `# Goal
Inspect the repository at ${root} and REPORT how @opslane/sdk should be wired in.
You have NO edit tools. Do not attempt to change any file. Only read and report.

# Investigate
Read the repository to determine:
- the ONE web app to onboard (monorepos have several packages — pick the primary
  user-facing web app; if genuinely ambiguous, call ask_user with multi:false)
- its framework (react-vite, vue-vite, nextjs, ...)
- the real entry point where init() should run
- the environment-variable naming convention this app uses for client vars (the prefix)
- the package manager (from the lock file)
- any error/monitoring SDK already installed (Sentry, PostHog, @defender-dev/sdk, @opslane/sdk, ...)
Base every field on what the files actually show.

# Report
Call report_plan exactly once. Name the Opslane vars after Opslane using THIS app's own
prefix (e.g. VITE_OPSLANE_API_KEY, or NEXT_PUBLIC_OPSLANE_API_KEY). Give the exact init
snippet you propose, placed to coexist with any existing SDK.`;

async function detect(root) {
  let plan = null, asked = null;
  const calls = [];
  const reportPlan = tool('report_plan', 'Report the onboarding plan. Call exactly once.', {
    app_dir: z.string(), framework: z.string(), entry_file: z.string(),
    env_prefix: z.string(), api_key_var: z.string(), endpoint_var: z.string(),
    package_manager: z.string(), existing_sdk: z.string(), dev_script: z.string(),
    init_snippet: z.string(),
  }, async (input) => { plan = input; return { content: [{ type: 'text', text: 'Plan recorded.' }] }; });
  const askUser = async ({ question, options }) => { asked = { question, options }; return [options[0]]; };
  const server = createSdkMcpServer({ name: 'onboard', version: '0.0.0',
    tools: [reportPlan, createAskUserTool(askUser), createSearchTool(root)] });
  const hook = onboardPreToolUseHook({ root, state: { finished: false } });
  const ac = new AbortController();
  let subtype;
  const t0 = Date.now();
  try {
    for await (const m of query({
      prompt: DETECT_PROMPT(root),
      options: {
        cwd: root, permissionMode: 'default', settingSources: [], strictMcpConfig: true,
        allowedTools: ['mcp__onboard__report_plan', 'mcp__onboard__ask_user'],
        tools: ['Read', 'Glob'],
        disallowedTools: ['Grep', 'Write', 'Edit', 'MultiEdit', 'Bash', 'WebFetch', 'WebSearch'],
        mcpServers: { onboard: server },
        hooks: { PreToolUse: [{ hooks: [hook] }] },
        canUseTool: async () => ({ behavior: 'allow' }),
        abortController: ac, maxTurns: 50,
      },
    })) {
      const bl = m?.message?.content;
      if (Array.isArray(bl)) for (const b of bl) if (b?.type === 'tool_use') calls.push(b.name);
      if (m?.type === 'result' && typeof m.subtype === 'string') subtype = m.subtype;
    }
  } catch (e) { subtype = `threw:${e.message}`; }
  return { plan, asked, calls, subtype, secs: ((Date.now() - t0) / 1000).toFixed(0) };
}

let anyFail = 0;
for (const root of roots) {
  process.stderr.write(`\n>>> detecting ${root}\n`);
  const r = await detect(root);
  console.log('\n================================================================');
  console.log('REPO:', root.split('/').pop(), '|', r.subtype, `| ${r.calls.length} tool-calls | ${r.secs}s`);
  if (r.asked) console.log('  ask_user:', r.asked.question, '->', JSON.stringify(r.asked.options));
  if (!r.plan) { console.log('  PLAN: (none reported)'); anyFail++; continue; }
  for (const k of ['app_dir','framework','entry_file','env_prefix','api_key_var','endpoint_var','package_manager','existing_sdk','dev_script'])
    console.log(`  ${k.padEnd(16)}: ${r.plan[k]}`);
  // sanity: the reported entry file must exist, or the Apply stage can't find it
  const entryExists = existsSync(resolve(root, r.plan.entry_file));
  const opslane = /(?:^|_)OPSLANE(?:_|$)/;
  const namingOk = opslane.test(r.plan.api_key_var) && opslane.test(r.plan.endpoint_var);
  console.log(`  entry exists    : ${entryExists ? 'yes' : 'NO — FAIL'}`);
  console.log(`  OPSLANE naming  : ${namingOk ? 'yes' : 'NO — FAIL'}`);
  if (!entryExists || !namingOk || r.subtype !== 'success') anyFail++;
  console.log('  init_snippet:');
  console.log(r.plan.init_snippet.split('\n').map((l) => '    ' + l).join('\n'));
}
console.log(`\n${anyFail === 0 ? 'ALL PLANS OK' : `${anyFail} REPO(S) FAILED A CHECK`}`);
process.exit(anyFail === 0 ? 0 : 1);
