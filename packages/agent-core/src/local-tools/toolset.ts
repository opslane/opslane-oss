import type { ToolSpec } from '../model-port.js';
import {
  createAddDependencyTool,
  type ExecFileRunner,
  type PackageManagerCommandResolver,
} from './add-dependency.js';
import { createFileTools } from './index.js';
import { createWriteSecretTool, type SecretVault } from './secrets.js';

export interface LocalToolset {
  tools: ToolSpec[];
  redact(text: string): string;
}

export interface LocalToolsetOptions {
  execFile?: ExecFileRunner;
  resolvePackageManagerCommand?: PackageManagerCommandResolver;
}

export function createLocalToolset(
  root: string,
  vault: SecretVault,
  options: LocalToolsetOptions = {},
): LocalToolset {
  return {
    tools: [
      ...createFileTools(root, vault),
      createAddDependencyTool(root, options.execFile, options.resolvePackageManagerCommand),
      createWriteSecretTool(root, vault),
    ],
    redact: (text) => vault.redact(text),
  };
}
