export function parseDraft(markdown) {
  const normalized = markdown.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const frontmatter = normalized.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/)?.[1];

  if (frontmatter === undefined) {
    throw new Error('Markdown must begin with a fenced frontmatter block.');
  }

  const draftFields = [...frontmatter.matchAll(/^draft:[^\n]*$/gm)];
  if (draftFields.length !== 1) {
    throw new Error(`Frontmatter must contain exactly one draft field; found ${draftFields.length}.`);
  }

  const value = draftFields[0][0].match(/^draft:[ \t]*(true|false)[ \t]*$/)?.[1];
  if (value === undefined) {
    throw new Error('The frontmatter draft field must be true or false.');
  }

  return value === 'true';
}
