import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  createSdkMcpServer,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { containedRepoRelative, isSecretFile } from './paths.js';

const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;
const ENV_VARIABLE = /^[A-Z][A-Z0-9_]*$/;
const OPSLANE_TOKEN = /(?:^|_)OPSLANE(?:_|$)/;
const SCRIPT_NAME = /^[A-Za-z0-9:_-]+$/;

export interface OnboardingAppReport {
  dir: string;
  apiKeyVar: string;
  endpointVar: string;
  packageManager: (typeof PACKAGE_MANAGERS)[number];
  devScript: string;
}

export interface OnboardingReport {
  apps: OnboardingAppReport[];
  editedFiles: string[];
}

export interface FinishState {
  finished: boolean;
}

type ServerTool = NonNullable<
  Parameters<typeof createSdkMcpServer>[0]['tools']
>[number];

export type AskUserResolver = (request: {
  question: string;
  options: string[];
  multi: boolean;
}) => Promise<string[]>;

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function containsSecretSegment(repoRelativePath: string): boolean {
  return repoRelativePath.split('/').some((segment) => isSecretFile(segment));
}

function validateRepoPath(root: string, value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty path`);
  }
  const relative = containedRepoRelative(root, value);
  if (containsSecretSegment(relative)) {
    throw new Error(`${label} points to a secret file`);
  }
  return relative || '.';
}

function validateApp(root: string, value: unknown): OnboardingAppReport {
  assertRecord(value, 'app');

  const dir = validateRepoPath(root, value.dir, 'app dir');
  if (
    typeof value.apiKeyVar !== 'string' ||
    !ENV_VARIABLE.test(value.apiKeyVar) ||
    !OPSLANE_TOKEN.test(value.apiKeyVar)
  ) {
    throw new Error(
      'API key variable must be an uppercase environment variable name containing OPSLANE',
    );
  }
  if (
    typeof value.endpointVar !== 'string' ||
    !ENV_VARIABLE.test(value.endpointVar) ||
    !OPSLANE_TOKEN.test(value.endpointVar)
  ) {
    throw new Error(
      'Endpoint variable must be an uppercase environment variable name containing OPSLANE',
    );
  }
  if (
    typeof value.packageManager !== 'string' ||
    !PACKAGE_MANAGERS.includes(value.packageManager as (typeof PACKAGE_MANAGERS)[number])
  ) {
    throw new Error('Unknown package manager');
  }
  if (typeof value.devScript !== 'string' || !SCRIPT_NAME.test(value.devScript)) {
    throw new Error('Invalid development script name');
  }

  let packageJson: unknown;
  try {
    packageJson = JSON.parse(readFileSync(path.join(root, dir, 'package.json'), 'utf8'));
  } catch {
    throw new Error(`Cannot read package.json for app directory ${value.dir as string}`);
  }
  assertRecord(packageJson, 'package.json');
  const scripts = packageJson.scripts;
  if (
    typeof scripts !== 'object' ||
    scripts === null ||
    Array.isArray(scripts) ||
    typeof (scripts as Record<string, unknown>)[value.devScript] !== 'string'
  ) {
    throw new Error(`Development script '${value.devScript}' does not exist`);
  }

  return {
    dir,
    apiKeyVar: value.apiKeyVar,
    endpointVar: value.endpointVar,
    packageManager: value.packageManager as OnboardingAppReport['packageManager'],
    devScript: value.devScript,
  };
}

function validateReport(root: string, value: unknown): OnboardingReport {
  assertRecord(value, 'onboarding report');
  if (!Array.isArray(value.apps) || value.apps.length !== 1) {
    throw new Error('Onboarding report must contain exactly one app');
  }
  if (!Array.isArray(value.editedFiles) || value.editedFiles.length === 0) {
    throw new Error('Onboarding report editedFiles must be non-empty');
  }

  const apps = value.apps.map((app) => validateApp(root, app));
  const editedFiles = value.editedFiles.map((file) => {
    return validateRepoPath(root, file, 'edited file');
  });
  return { apps, editedFiles };
}

export function createAskUserTool(resolver: AskUserResolver | null) {
  return tool(
    'ask_user',
    'Ask the user to choose one or more options before continuing.',
    {
      question: z.string(),
      options: z.array(z.string()).min(1),
      multi: z.boolean().default(false),
    },
    async ({ question, options, multi }) => {
      if (resolver === null) {
        throw new Error('ask_user resolver not installed');
      }
      const choices = await resolver({ question, options, multi });
      return {
        content: [{ type: 'text', text: `User chose: ${choices.join(', ')}` }],
      };
    },
  );
}

export function createFinishTool(
  root: string,
  state: FinishState,
  onReport: (report: OnboardingReport) => void,
) {
  const finishShape = {
    apps: z.array(
      z.object({
        dir: z.string(),
        apiKeyVar: z.string(),
        endpointVar: z.string(),
        packageManager: z.string(),
        devScript: z.string(),
      }),
    ),
    editedFiles: z.array(z.string()),
  };
  return tool(
    'finish_onboarding',
    'Submit the final onboarding report after all approved edits and checks are complete.',
    finishShape,
    async (args) => {
      if (state.finished) {
        throw new Error('Onboarding is already finished');
      }
      const report = validateReport(root, args);
      onReport(report);
      state.finished = true;
      return {
        content: [{ type: 'text', text: 'Onboarding report accepted.' }],
      };
    },
  );
}

export function createAskServer(...tools: ServerTool[]) {
  return createSdkMcpServer({ name: 'onboard', version: '0.0.0', tools });
}
