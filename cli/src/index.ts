#!/usr/bin/env node

import { Command } from 'commander';
import { login } from './login.js';
import { init } from './init.js';
import { doctor } from './doctor.js';
import { setup } from './setup.js';
import { snippet } from './snippet.js';
import { verify } from './verify.js';
import { status } from './status.js';
import { listErrors, getError } from './errors.js';

const program = new Command();

program
  .name('opslane')
  .description('Opslane CLI - AI-powered production error resolution')
  .version('0.0.1');

program
  .command('login')
  .description('Authenticate with Opslane and connect GitHub')
  .action(() => login());

program
  .command('init')
  .description('Initialize Opslane in the current project')
  .option('--api-key <key>', 'Your Opslane API key')
  .action((opts: { apiKey?: string }) => init({ apiKey: opts.apiKey }));

program
  .command('doctor')
  .description('Check Opslane setup health')
  .option('--fix', 'Attempt to auto-fix common issues')
  .action(async (opts: { fix?: boolean }) => {
    await doctor({ fix: opts.fix });
  });

// Agent-first onboarding commands
program
  .command('setup')
  .description('Set up Opslane for this repo (agent-first onboarding)')
  .option('--poll <id>', 'Resume polling an existing setup session')
  .option('--api-url <url>', 'Opslane API URL')
  .option('--repo-url <url>', 'Override auto-detected repo URL')
  .option('--agent-name <name>', 'Agent identifier (e.g., "claude-code")')
  .action(async (opts: { poll?: string; apiUrl?: string; repoUrl?: string; agentName?: string }) => {
    await setup(opts);
  });

program
  .command('snippet')
  .description('Get framework-specific SDK init code')
  .option('--framework <name>', 'Override auto-detected framework')
  .option('--api-key <key>', 'API key to embed in snippet')
  .action(async (opts: { framework?: string; apiKey?: string }) => {
    await snippet(opts);
  });

program
  .command('verify')
  .description('Check if Opslane is connected and receiving events')
  .action(async () => {
    await verify();
  });

program
  .command('status')
  .description('Show current Opslane project and auth state')
  .action(async () => {
    await status();
  });

const errorsCmd = program
  .command('errors')
  .description('View error groups');

errorsCmd
  .command('list')
  .description('List error groups')
  .option('--status <status>', 'Filter by status')
  .option('--limit <n>', 'Maximum results', '25')
  .action(async (opts: { status?: string; limit?: string }) => {
    await listErrors({ status: opts.status, limit: parseInt(opts.limit ?? '25', 10) });
  });

errorsCmd
  .command('get <id>')
  .description('Get error group details')
  .action(async (id: string) => {
    await getError(id);
  });

program.parse();
