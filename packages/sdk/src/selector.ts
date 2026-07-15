/**
 * Derives a bounded, stable CSS selector without capturing free text or
 * arbitrary attribute values. Selectors live outside the masked recording and
 * can later reach an LLM, so privacy takes priority over specificity.
 */

const ALLOWED_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy'];
const MAX_DEPTH = 8;
const MAX_LENGTH = 256;

function isHashLike(value: string): boolean {
  if (value.length >= 16 && /^[a-f0-9]+$/i.test(value)) return true;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value);
}

function isDynamicClass(value: string): boolean {
  if (/^(css|sc|emotion|jsx)-/i.test(value)) return true;
  if (/\d/.test(value) && /^[a-z]+[-_]?[a-z0-9]{5,}$/i.test(value)) return true;
  return isHashLike(value);
}

function escapeIdent(value: string): string {
  try {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  } catch {
    // Fall through to a conservative escape.
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function nthOfType(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const parent = element.parentElement;
  if (!parent) return tag;
  const siblings = Array.from(parent.children).filter((child) => child.tagName === element.tagName);
  if (siblings.length === 1) return tag;
  return `${tag}:nth-of-type(${siblings.indexOf(element) + 1})`;
}

export function deriveSelector(element: Element | null): string {
  if (!element?.tagName) return '';
  try {
    for (const attr of ALLOWED_ATTRS) {
      const value = element.getAttribute(attr);
      if (value && !isHashLike(value)) {
        // Backslash first: escaping the quote first would then escape the
        // backslash we just added, letting a value ending in \ close the string.
        const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return `[${attr}="${escaped}"]`.slice(0, MAX_LENGTH);
      }
    }

    if (element.id && !isHashLike(element.id)) {
      return `#${escapeIdent(element.id)}`.slice(0, MAX_LENGTH);
    }

    const parts: string[] = [];
    let node: Element | null = element;
    let depth = 0;
    while (node && depth < MAX_DEPTH && node.tagName !== 'HTML') {
      let part = nthOfType(node);
      const classes = Array.from(node.classList)
        .filter((value) => !isDynamicClass(value))
        .slice(0, 2);
      if (classes.length > 0) part += classes.map((value) => `.${escapeIdent(value)}`).join('');
      parts.unshift(part);
      if (node.id && !isHashLike(node.id)) {
        parts.unshift(`#${escapeIdent(node.id)}`);
        break;
      }
      node = node.parentElement;
      depth += 1;
    }
    return parts.join(' > ').slice(0, MAX_LENGTH);
  } catch {
    return '';
  }
}
