import type { FilePatch } from './codemods/types.js';

/**
 * AI fallback for unknown frameworks.
 *
 * When no deterministic codemod exists, generates a template file with
 * SDK setup instructions as comments. Does NOT call any LLM API yet --
 * this is a stub for future AI-assisted codemod generation.
 */
export async function generateFallbackPatches(
  _projectRoot: string,
): Promise<FilePatch[]> {
  return [
    {
      filePath: 'opslane-init.ts',
      action: 'create',
      content: [
        '/**',
        ' * Opslane SDK Initialization',
        ' *',
        ' * Your framework was not automatically detected.',
        ' * Follow these steps to integrate the Opslane SDK:',
        ' *',
        ' * 1. Install the SDK:',
        ' *    npm install @opslane/sdk',
        ' *',
        ' * 2. Import and initialize in your app entry point:',
        ' *    import { OpslaneSDK } from "@opslane/sdk";',
        " *    OpslaneSDK.init({ apiKey: '<YOUR_API_KEY>' });",
        ' *',
        ' * 3. The SDK will automatically capture:',
        ' *    - Unhandled errors (window.onerror)',
        ' *    - Unhandled promise rejections',
        ' *    - Console errors',
        ' *    - Network request failures',
        ' *',
        ' * 4. To manually report an error:',
        ' *    OpslaneSDK.captureException(error);',
        ' */',
        '',
        "import { OpslaneSDK } from '@opslane/sdk';",
        '',
        'OpslaneSDK.init({',
        "  apiKey: '<YOUR_API_KEY>',",
        '});',
        '',
        'export { OpslaneSDK };',
        '',
      ].join('\n'),
    },
  ];
}
