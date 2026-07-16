import { defineCollection } from 'astro:content';
import { docsSchema } from '@astrojs/starlight/schema';

import { repoDocsLoader } from './loaders/repo-docs';

export const collections = {
  docs: defineCollection({ loader: repoDocsLoader(), schema: docsSchema() }),
};
