import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  createSdkMcpServer,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { containedRepoRelative, hasSecretSegment } from './paths.js';

const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;
/**
 * What Apply should do about an error/monitoring SDK already in the repo.
 *
 *   none    - no error SDK found at all. Apply proceeds normally. (the common case)
 *   keep    - another SDK is present; install Opslane alongside it. `name` is that SDK.
 *   migrate - replace the named SDK with Opslane. `name` is that SDK.
 *   no_op   - @opslane/sdk is ALREADY installed; Apply should change nothing.
 *
 * `none` exists because without it the model reached for `no_op` on a repo with no
 * SDK (observed live on directus), which would have told Apply "already onboarded"
 * and silently skipped a repo that needed the work.
 */
const EXISTING_SDK_ACTIONS = ['none', 'keep', 'migrate', 'no_op'] as const;
const EDIT_POSITIONS = ['before', 'after'] as const;
const ENV_VARIABLE = /^[A-Z][A-Z0-9_]*$/;
const OPSLANE_TOKEN = /(?:^|_)OPSLANE(?:_|$)/;

export interface OnboardingPlan {
  app_dir: string;
  framework: string;
  package_manager: (typeof PACKAGE_MANAGERS)[number];
  env_prefix: string;
  dependency: {
    name: '@opslane/sdk';
    version: string;
  };
  env_vars: {
    api_key: string;
    endpoint: string;
  };
  edit: {
    file: string;
    entry_hash: string;
    import_line: string;
    init_block: string;
    anchor: string;
    position: (typeof EDIT_POSITIONS)[number];
    occurrence: number;
  };
  existing_sdk: {
    action: (typeof EXISTING_SDK_ACTIONS)[number];
    name: string | null;
  };
  rationale: string;
}

/**
 * What the MODEL supplies: the full plan minus `edit.entry_hash`.
 *
 * The Detect agent has only Read/Glob/search — it cannot compute a sha256, so
 * asking it for one made every report_plan call unsatisfiable (it retried until
 * the turn budget ran out and reported no plan at all). The host stamps the hash
 * from the file it already reads while validating. Exact facts belong to code;
 * judgment belongs to the model.
 */
export type ReportedPlanInput = Omit<OnboardingPlan, 'edit'> & {
  edit: Omit<OnboardingPlan['edit'], 'entry_hash'>;
};

export type ReportPlanInput =
  | { status: 'ok'; plan: ReportedPlanInput }
  | { status: 'unsupported'; reason: string };

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

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new Error(`Unknown ${label}: ${String(value)}`);
  }
  return value as Values[number];
}

function canonicalRepoPath(root: string, value: unknown, label: string): string {
  const candidate = nonEmptyString(value, label);
  const relative = containedRepoRelative(root, candidate) || '.';
  if (hasSecretSegment(relative)) {
    throw new Error(`${label} points to a secret file`);
  }
  return relative;
}

function isUnderDirectory(directory: string, file: string): boolean {
  if (directory === '.') return file !== '.';
  const relative = path.posix.relative(directory, file);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith('../') &&
    !path.posix.isAbsolute(relative)
  );
}

function validateEnvironmentVariable(
  value: unknown,
  envPrefix: string,
  label: string,
): string {
  const variable = nonEmptyString(value, label);
  if (
    !ENV_VARIABLE.test(variable) ||
    !variable.startsWith(envPrefix) ||
    !OPSLANE_TOKEN.test(variable)
  ) {
    throw new Error(
      `${label} must be an uppercase environment variable using prefix ${envPrefix} and containing OPSLANE`,
    );
  }
  return variable;
}

function countOccurrences(contents: string, anchor: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= contents.length - anchor.length) {
    const index = contents.indexOf(anchor, offset);
    if (index === -1) break;
    count += 1;
    offset = index + anchor.length;
  }
  return count;
}

function validatePlan(root: string, value: unknown): OnboardingPlan {
  assertRecord(value, 'plan');

  const appDir = canonicalRepoPath(root, value.app_dir, 'app_dir');
  const framework = nonEmptyString(value.framework, 'framework');
  const packageManager = enumValue(value.package_manager, PACKAGE_MANAGERS, 'package manager');
  const envPrefix = nonEmptyString(value.env_prefix, 'env_prefix');
  const rationale = nonEmptyString(value.rationale, 'rationale');

  assertRecord(value.dependency, 'dependency');
  const dependencyName = nonEmptyString(value.dependency.name, 'dependency.name');
  if (dependencyName !== '@opslane/sdk') {
    throw new Error('dependency.name must be @opslane/sdk');
  }
  const dependencyVersion = nonEmptyString(value.dependency.version, 'dependency.version');

  assertRecord(value.env_vars, 'env_vars');
  const apiKey = validateEnvironmentVariable(value.env_vars.api_key, envPrefix, 'env_vars.api_key');
  const endpoint = validateEnvironmentVariable(
    value.env_vars.endpoint,
    envPrefix,
    'env_vars.endpoint',
  );

  assertRecord(value.edit, 'edit');
  const editFile = canonicalRepoPath(root, value.edit.file, 'edit.file');
  if (!isUnderDirectory(appDir, editFile)) {
    throw new Error('edit.file must be under app_dir');
  }

  const editAbsolute = path.join(root, editFile);
  let fileContents: Buffer;
  try {
    if (!statSync(editAbsolute).isFile()) {
      throw new Error('not a regular file');
    }
    fileContents = readFileSync(editAbsolute);
  } catch {
    throw new Error('edit.file must exist and be a regular file');
  }

  // Host-derived, never model-supplied: the agent has no way to compute a
  // sha256. Apply re-hashes this file and refuses a stale plan.
  const entryHash = createHash('sha256').update(fileContents).digest('hex');

  const importLine = nonEmptyString(value.edit.import_line, 'edit.import_line');
  const initBlock = nonEmptyString(value.edit.init_block, 'edit.init_block');
  const anchor = nonEmptyString(value.edit.anchor, 'edit.anchor');
  const position = enumValue(value.edit.position, EDIT_POSITIONS, 'edit position');
  const occurrence = value.edit.occurrence;
  if (!Number.isInteger(occurrence) || (occurrence as number) < 0) {
    throw new Error('edit.occurrence must be a non-negative integer');
  }
  if (countOccurrences(fileContents.toString('utf8'), anchor) <= (occurrence as number)) {
    throw new Error('edit.anchor does not occur at edit.occurrence in edit.file');
  }

  assertRecord(value.existing_sdk, 'existing_sdk');
  const existingAction = enumValue(
    value.existing_sdk.action,
    EXISTING_SDK_ACTIONS,
    'existing SDK action',
  );
  const existingName =
    value.existing_sdk.name === null
      ? null
      : nonEmptyString(value.existing_sdk.name, 'existing_sdk.name');
  // `keep` and `migrate` describe an action ON a named SDK, so a null name
  // makes the plan unapplyable; `none` means no SDK was found, so a name
  // contradicts it. Apply reads both fields, so the pairing must hold here.
  if ((existingAction === 'keep' || existingAction === 'migrate') && existingName === null) {
    throw new Error(`existing_sdk.name is required when action is ${existingAction}`);
  }
  if (existingAction === 'none' && existingName !== null) {
    throw new Error('existing_sdk.name must be null when action is none');
  }

  return {
    app_dir: appDir,
    framework,
    package_manager: packageManager,
    env_prefix: envPrefix,
    dependency: { name: '@opslane/sdk', version: dependencyVersion },
    env_vars: { api_key: apiKey, endpoint },
    edit: {
      file: editFile,
      entry_hash: entryHash,
      import_line: importLine,
      init_block: initBlock,
      anchor,
      position,
      occurrence: occurrence as number,
    },
    existing_sdk: { action: existingAction, name: existingName },
    rationale,
  };
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
    async ({ question, options, multi = false }) => {
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

export function createReportPlanTool(
  root: string,
  onPlan: (plan: OnboardingPlan) => void,
  onUnsupported: (reason: string) => void = () => undefined,
) {
  let reported = false;
  const planShape = z.object({
    app_dir: z.string(),
    framework: z.string(),
    package_manager: z.enum(PACKAGE_MANAGERS),
    env_prefix: z.string(),
    dependency: z.object({
      name: z.literal('@opslane/sdk'),
      version: z.string(),
    }),
    env_vars: z.object({
      api_key: z.string(),
      endpoint: z.string(),
    }),
    edit: z.object({
      file: z.string(),
      // NOTE: no `entry_hash` here on purpose. The Detect agent has only
      // Read/Glob/search and cannot compute a sha256, so requiring it from the
      // model made every report_plan call unsatisfiable (it retried until the
      // turn budget ran out and produced no plan). The host stamps the hash
      // below from the file it already reads. Exact facts belong to code.
      import_line: z.string(),
      init_block: z.string(),
      anchor: z.string(),
      position: z.enum(EDIT_POSITIONS),
      occurrence: z.number().int().nonnegative(),
    }),
    existing_sdk: z.object({
      action: z.enum(EXISTING_SDK_ACTIONS),
      name: z.string().nullable(),
    }),
    rationale: z.string(),
  });

  return tool(
    'report_plan',
    'Report the validated read-only onboarding plan exactly once.',
    {
      status: z.enum(['ok', 'unsupported']),
      plan: planShape.optional(),
      reason: z.string().optional(),
    },
    async (input) => {
      if (reported) {
        throw new Error('Onboarding plan was already reported');
      }
      assertRecord(input, 'report_plan input');

      if (input.status === 'unsupported') {
        if (input.plan !== undefined) {
          throw new Error('unsupported report must not include a plan');
        }
        const reason = nonEmptyString(input.reason, 'reason');
        reported = true;
        onUnsupported(reason);
        return {
          content: [{ type: 'text', text: 'Unsupported repository result accepted.' }],
        };
      }
      if (input.status !== 'ok') {
        throw new Error('status must be ok or unsupported');
      }
      if (input.reason !== undefined) {
        throw new Error('ok report must not include an unsupported reason');
      }

      const plan = validatePlan(root, input.plan);
      reported = true;
      onPlan(plan);
      return {
        content: [{ type: 'text', text: 'Onboarding plan accepted.' }],
      };
    },
  );
}

export function createOnboardServer(...tools: ServerTool[]) {
  return createSdkMcpServer({ name: 'onboard', version: '0.0.0', tools });
}
