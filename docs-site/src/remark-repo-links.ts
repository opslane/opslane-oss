import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import type { Definition, Image, Link, Root } from 'mdast';
import type { Plugin } from 'unified';
import { visit } from 'unist-util-visit';

import { canonicalId, isAllowedCanonicalPath } from './loaders/repo-docs';
import { GITHUB_BLOB_BASE, GITHUB_RAW_BASE } from './repo';

interface RepoLinksOptions {
  repoRoot: string;
}

function splitUrl(url: string): { pathname: string; suffix: string } {
  const match = url.match(/^([^?#]*)(.*)$/);
  return { pathname: match?.[1] ?? url, suffix: match?.[2] ?? '' };
}

function isExternalOrRoute(url: string): boolean {
  return (
    url.startsWith('/') ||
    url.startsWith('#') ||
    url.startsWith('?') ||
    url.startsWith('//') ||
    /^[a-z][a-z\d+.-]*:/i.test(url)
  );
}

export const remarkRepoLinks: Plugin<[RepoLinksOptions], Root> = ({ repoRoot }) => (tree, file) => {
  const sourcePath = file.history[0];
  if (!sourcePath) return;

  const absoluteRepoRoot = path.resolve(repoRoot);

  const rewrite = (node: Link | Definition | Image) => {
    if (isExternalOrRoute(node.url)) return;

    const { pathname, suffix } = splitUrl(node.url);
    if (!pathname) return;

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      return;
    }

    const target = path.resolve(path.dirname(sourcePath), decodedPath);
    const repoRelative = path.relative(absoluteRepoRoot, target).replaceAll(path.sep, '/');
    if (repoRelative.startsWith('../') || path.isAbsolute(repoRelative)) return;
    if (!existsSync(target) || !statSync(target).isFile()) return;

    // Images are never site pages. Rewrite every repo-file image to the raw
    // host so Astro's asset pipeline can never copy an excluded file into dist.
    if (node.type === 'image') {
      node.url = `${GITHUB_RAW_BASE}${encodeURI(repoRelative)}${suffix}`;
      return;
    }

    if (repoRelative.startsWith('docs/')) {
      const docsRelative = repoRelative.slice('docs/'.length);
      if (isAllowedCanonicalPath(docsRelative)) {
        node.url = `/${canonicalId(docsRelative)}/${suffix}`;
        return;
      }
    }

    node.url = `${GITHUB_BLOB_BASE}${encodeURI(repoRelative)}${suffix}`;
  };

  visit(tree, 'link', rewrite);
  visit(tree, 'definition', rewrite);
  visit(tree, 'image', rewrite);
};

export default remarkRepoLinks;
