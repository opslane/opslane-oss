// Parses `git diff --name-status -z --find-renames` output without losing
// rename/copy source paths. The caller owns all git operations.
export function parseNameStatusZ(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : input;
  if (typeof text !== 'string') throw new TypeError('name-status input must be a string or Buffer');

  const tokens = text.split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  if (tokens.length === 0) return [];

  const paths = [];
  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index++];
    if (!/^(?:[ACDMRTUXB]|[RC]\d{1,3})$/.test(status)) {
      throw new Error(`unknown git status: ${status || '<empty>'}`);
    }

    const pathCount = /^[RC]\d{1,3}$/.test(status) ? 2 : 1;
    for (let offset = 0; offset < pathCount; offset += 1) {
      const path = tokens[index++];
      if (!path) throw new Error(`missing path for git status ${status}`);
      paths.push(path);
    }
  }

  return [...new Set(paths)];
}
