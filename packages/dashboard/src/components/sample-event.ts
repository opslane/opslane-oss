export interface RequestHeader {
  name: string;
  value: string;
}

export interface RequestContext {
  method?: string;
  path?: string;
  remote_addr?: string;
  headers?: RequestHeader[];
}

export interface BreadcrumbDisplay {
  timestamp?: string;
  label?: string;
  level?: string;
  message?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

export function getRequestContext(
  context: Record<string, unknown>,
): RequestContext | null {
  const request = context['request'];
  if (!isRecord(request)) return null;

  const rawHeaders = request['headers'];
  const headers = isRecord(rawHeaders)
    ? Object.entries(rawHeaders).flatMap(([name, value]) => (
      typeof value === 'string' ? [{ name, value }] : []
    ))
    : [];

  return {
    method: stringField(request, 'method'),
    path: stringField(request, 'path'),
    remote_addr: stringField(request, 'remote_addr'),
    headers: headers.length > 0 ? headers : undefined,
  };
}

export function formatBreadcrumb(value: unknown): BreadcrumbDisplay | null {
  if (!isRecord(value)) return null;

  const type = stringField(value, 'type');
  const category = stringField(value, 'category');
  const timestamp = stringField(value, 'timestamp');
  const level = stringField(value, 'level');
  const message = stringField(value, 'message');

  if (!type && !category && !timestamp && !level && !message) return null;

  return {
    timestamp,
    label: [type, category].filter((part): part is string => Boolean(part)).join(' · ') || undefined,
    level,
    message,
  };
}
