import type { Root } from 'mdast';
import type { Plugin } from 'unified';

const remarkStripH1: Plugin<[], Root> = () => (tree) => {
  const index = tree.children.findIndex((node) => node.type === 'heading' && node.depth === 1);
  if (index !== -1) tree.children.splice(index, 1);
};

export default remarkStripH1;
