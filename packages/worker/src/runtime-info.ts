export interface RuntimeInfo {
  name: string;
  version: string;
}

export function sanitizeRuntimeValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const sanitized = value.replace(/[^A-Za-z0-9._+\- ]/g, '').trim().slice(0, 64);
  return sanitized || null;
}

/** Parse customer runtime metadata defensively. Event context is untrusted input. */
export function parseRuntimeInfo(context: string): RuntimeInfo | null {
  try {
    const parsed: unknown = JSON.parse(context);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const runtime = (parsed as Record<string, unknown>)['runtime'];
    if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) return null;
    const record = runtime as Record<string, unknown>;
    const name = sanitizeRuntimeValue(record['name']);
    const version = sanitizeRuntimeValue(record['version']);
    return name && version ? { name, version } : null;
  } catch {
    return null;
  }
}

export function formatRuntime(runtime: RuntimeInfo | null | undefined): string {
  return runtime ? `${runtime.name} ${runtime.version}` : 'unknown';
}
