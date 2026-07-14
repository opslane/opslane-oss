export interface SourceMapPluginOptions {
  endpoint: string;
  apiKey: string;
  release?: string;
}

interface BundleAsset {
  type: string;
  source?: string;
  fileName: string;
}

interface CollectedMap {
  file_path: string;
  source_map: string;
}

export function opslaneSourceMapPlugin(options: SourceMapPluginOptions) {
  const collectedMaps: CollectedMap[] = [];

  return {
    name: 'opslane-source-map',
    apply: 'build' as const,
    enforce: 'post' as const,

    config() {
      return {
        build: {
          sourcemap: 'hidden' as const,
        },
      };
    },

    generateBundle(
      _outputOptions: unknown,
      bundle: Record<string, BundleAsset>
    ): void {
      const mapKeys = Object.keys(bundle).filter((key) =>
        key.endsWith('.map')
      );

      for (const key of mapKeys) {
        const asset = bundle[key];
        const source =
          typeof asset.source === 'string'
            ? asset.source
            : String(asset.source || '');

        collectedMaps.push({
          file_path: stripMapSuffix(asset.fileName),
          source_map: source,
        });
        delete bundle[key];
      }
    },

    async closeBundle(): Promise<void> {
      if (collectedMaps.length === 0) return;
      if (!options.apiKey) return;

      // C5: release comes from the option or the shared env var the SDK's
      // init({release}) reads — never auto-invented. An unmatchable release is
      // worse than none, so when missing we warn loudly and skip the upload.
      const release = options.release || readReleaseEnv() || '';
      if (!release) {
        console.warn(
          '[opslane] No release set — source maps were NOT uploaded, so production stacks ' +
            'will not resolve. Set VITE_OPSLANE_RELEASE (e.g. to your git SHA) and pass the same ' +
            'value to Opslane.init({ release }).'
        );
        return;
      }

      for (const map of collectedMaps) {
        try {
          const formData = new FormData();
          formData.append('release', release);
          formData.append('file', new Blob([map.source_map], { type: 'application/json' }), map.file_path + '.map');

          const response = await fetch(
            `${options.endpoint}/api/v1/sourcemaps`,
            {
              method: 'POST',
              headers: {
                'X-API-Key': options.apiKey,
              },
              body: formData,
            }
          );

          if (!response.ok) {
            console.warn(
              `[opslane] Source map upload failed for ${map.file_path}: ${response.status} ${response.statusText}`
            );
          }
        } catch (error) {
          console.warn(
            `[opslane] Source map upload failed for ${map.file_path}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    },
  };
}

/** Read VITE_OPSLANE_RELEASE without depending on @types/node globals. */
function readReleaseEnv(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.VITE_OPSLANE_RELEASE;
}

function stripMapSuffix(filePath: string): string {
  return filePath.endsWith('.map') ? filePath.slice(0, -4) : filePath;
}
