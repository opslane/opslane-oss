import type { Root } from 'mdast';
import { unified } from 'unified';
import { describe, expect, it } from 'vitest';

import remarkStripH1 from '../remark-strip-h1';

it('removes the first H1 without changing later headings', () => {
  const tree: Root = {
    type: 'root',
    children: [
      { type: 'paragraph', children: [{ type: 'text', value: 'Intro' }] },
      { type: 'heading', depth: 1, children: [{ type: 'text', value: 'Title' }] },
      { type: 'heading', depth: 2, children: [{ type: 'text', value: 'Section' }] },
    ],
  };

  unified().use(remarkStripH1).runSync(tree);

  expect(tree.children.map((node) => (node.type === 'heading' ? node.depth : node.type))).toEqual([
    'paragraph',
    2,
  ]);
});

describe('when there is no H1', () => {
  it('leaves the tree untouched', () => {
    const tree: Root = { type: 'root', children: [] };
    unified().use(remarkStripH1).runSync(tree);
    expect(tree.children).toEqual([]);
  });
});
