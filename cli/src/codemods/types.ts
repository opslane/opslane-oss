export interface Codemod {
  framework: string;
  description: string;
  /** Returns array of file patches to apply */
  generate(projectRoot: string): Promise<FilePatch[]>;
}

export interface FilePatch {
  filePath: string; // relative to project root
  action: 'create' | 'modify';
  content?: string; // full content for create
  insertAfter?: string; // pattern to find for modify
  insertContent?: string; // what to insert after the pattern
}
