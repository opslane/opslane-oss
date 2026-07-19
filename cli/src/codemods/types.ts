export interface Codemod {
  framework: string;
  description: string;
  /** Returns array of file patches to apply */
  generate(projectRoot: string): Promise<FilePatch[]>;
}

export interface FilePatch {
  filePath: string; // relative to project root
  action: 'create' | 'replace' | 'modify';
  content?: string; // full content for create/replace
  insertAfter?: string; // pattern to find for modify
  insertContent?: string; // what to insert after the pattern
}
