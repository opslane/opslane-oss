import type {
  Incident, AffectedUser, Account, IncidentFilters,
  GitHubConfig, GitHubAppStatus, GitHubRepo, SetupPrStatus,
} from './types/api';

const BASE = '/api/v1';

// === Auth state ===
//
// Tokens live only in httpOnly cookies set by the backend. JS keeps a non-secret
// hint so the synchronous router guard can decide "probably authenticated"; the
// cookie remains the server-enforced source of truth.

const AUTHED_KEY = 'opslane_authed';

// One-time cleanup of pre-cookie token storage. These are the historical key
// names an older build actually wrote — do not rename them.
localStorage.removeItem('defender_access_token');
localStorage.removeItem('defender_refresh_token');
localStorage.removeItem('defender_token_expires_at');

export interface AuthUser {
  id: string;
  org_id: string;
  email: string;
  name: string;
}

export function isAuthenticated(): boolean {
  return !!localStorage.getItem(AUTHED_KEY);
}

export function markAuthed(): void {
  localStorage.setItem(AUTHED_KEY, '1');
}

export function clearAuth(): void {
  localStorage.removeItem(AUTHED_KEY);
  // Historical pre-cookie key names — do not rename.
  localStorage.removeItem('defender_access_token');
  localStorage.removeItem('defender_refresh_token');
  localStorage.removeItem('defender_token_expires_at');
}


// Deduplicates concurrent refresh calls so only one hits the backend.
// Without this, parallel fetchWithAuth calls near token expiry would each
// consume the single-use refresh token, causing spurious logouts.
let inflightRefresh: Promise<boolean> | null = null;

function refreshTokens(): Promise<boolean> {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = doRefresh().finally(() => { inflightRefresh = null; });
  return inflightRefresh;
}

async function doRefresh(): Promise<boolean> {
  try {
    const res = await fetch('/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    });

    if (!res.ok) {
      clearAuth();
      return false;
    }

    markAuthed();
    return true;
  } catch {
    clearAuth();
    return false;
  }
}

// === Shared auth-aware fetch core ===

async function fetchWithAuth<T>(path: string, options: RequestInit = {}): Promise<T> {
  const doFetch = (): Promise<Response> =>
    fetch(`${BASE}${path}`, { ...options, credentials: 'include' });

  let res = await doFetch();

  if (res.status === 401) {
    const refreshed = await refreshTokens();
    if (refreshed) {
      res = await doFetch();
    } else {
      clearAuth();
      window.location.href = '/login';
      throw new Error('Session expired');
    }
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// === HTTP helpers ===

export function fetchJSON<T>(path: string): Promise<T> {
  return fetchWithAuth<T>(path);
}

export function postJSON<T>(path: string, body: unknown): Promise<T> {
  return fetchWithAuth<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function patchJSON<T>(path: string, body: unknown): Promise<T> {
  return fetchWithAuth<T>(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function deleteJSON<T>(path: string): Promise<T> {
  return fetchWithAuth<T>(path, { method: 'DELETE' });
}

// === Types ===

export interface Project {
  id: string;
  name: string;
  github_repo: string | null;
  created_at: string;
}

export interface Environment {
  id: string;
  project_id: string;
  name: string;
  created_at: string;
}

export interface APIKey {
  id: string;
  environment_id: string;
  environment_name: string;
  key_prefix: string;
  revoked_at: string | null;
  created_at: string;
}

export interface APIKeyCreated {
  id: string;
  raw_key: string;
  key_prefix: string;
  created_at: string;
}

export interface OnboardingSetupResponse {
  project: Project;
  environment: Environment;
  api_key: APIKeyCreated;
}

export interface EventStatus {
  has_events: boolean;
}

// === Project D: replay ===
export interface ReplayRecording {
  events: unknown[];
  meta?: {
    sdk_version?: string;
    page_url?: string;
    started_at?: string;
    ended_at?: string;
    crash_timestamp?: number;
  };
}

// === API functions ===

export function getMe(): Promise<AuthUser> {
  return fetchJSON<AuthUser>('/auth/me');
}

export function listProjects(): Promise<Project[]> {
  return fetchJSON<Project[]>('/projects');
}

export function createProject(name: string, githubRepo: string): Promise<Project> {
  return postJSON<Project>('/projects', { name, github_repo: githubRepo || undefined });
}

export function updateProject(
  projectId: string,
  data: { github_repo?: string }
): Promise<Project> {
  return patchJSON<Project>(`/projects/${projectId}`, data);
}

export function listEnvironments(projectId: string): Promise<Environment[]> {
  return fetchJSON<Environment[]>(`/projects/${projectId}/environments`);
}

export function createEnvironment(projectId: string, name: string): Promise<Environment> {
  return postJSON<Environment>(`/projects/${projectId}/environments`, { name });
}

export function createAPIKey(envId: string): Promise<APIKeyCreated> {
  return postJSON<APIKeyCreated>(`/environments/${envId}/api-keys`, {});
}

export function listAPIKeys(projectId: string): Promise<APIKey[]> {
  return fetchJSON<APIKey[]>(`/projects/${projectId}/api-keys`);
}

export function onboardingSetup(
  projectName: string,
  githubRepo: string
): Promise<OnboardingSetupResponse> {
  return postJSON<OnboardingSetupResponse>('/onboarding/setup', {
    project_name: projectName,
    github_repo: githubRepo || undefined,
  });
}

export function getEventStatus(projectId: string): Promise<EventStatus> {
  return fetchJSON<EventStatus>(`/projects/${projectId}/event-count`);
}

export function getGitHubConfig(projectId: string): Promise<GitHubConfig> {
  return fetchJSON<GitHubConfig>(`/projects/${projectId}/github`);
}

export function setGitHubConfig(
  projectId: string,
  data: { github_repo: string }
): Promise<GitHubConfig> {
  return fetchWithAuth<GitHubConfig>(`/projects/${projectId}/github`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export function deleteGitHubConfig(projectId: string): Promise<{ ok: boolean }> {
  return deleteJSON<{ ok: boolean }>(`/projects/${projectId}/github`);
}

// === GitHub App ===

export function getGitHubAppStatus(): Promise<GitHubAppStatus> {
  return fetchJSON<GitHubAppStatus>('/github/status');
}

export function listGitHubRepos(): Promise<GitHubRepo[]> {
  return fetchJSON<GitHubRepo[]>('/github/repos');
}

// === Project setup PR ===

export function triggerSetupPR(projectId: string): Promise<{ job_id: string; status: string }> {
  return postJSON<{ job_id: string; status: string }>(`/projects/${projectId}/setup-pr`, {});
}

export function getSetupPRStatus(projectId: string): Promise<SetupPrStatus> {
  return fetchJSON<SetupPrStatus>(`/projects/${projectId}/setup-pr`);
}

export function listIncidents(
  projectId: string,
  filters?: IncidentFilters
): Promise<Incident[]> {
  const params = new URLSearchParams();
  if (filters?.account_id) params.set('account_id', filters.account_id);
  if (filters?.end_user_id) params.set('end_user_id', filters.end_user_id);
  if (filters?.status) params.set('status', filters.status);
  const qs = params.toString();
  return fetchJSON<Incident[]>(
    `/projects/${projectId}/incidents${qs ? `?${qs}` : ''}`
  );
}

export function getIncident(
  projectId: string,
  incidentId: string
): Promise<Incident> {
  return fetchJSON<Incident>(
    `/projects/${projectId}/incidents/${incidentId}`
  );
}

export function getReplay(projectId: string, replayId: string): Promise<ReplayRecording> {
  return fetchJSON<ReplayRecording>(`/projects/${projectId}/replays/${replayId}`);
}

export function listAffectedUsers(
  projectId: string,
  incidentId: string
): Promise<AffectedUser[]> {
  return fetchJSON<AffectedUser[]>(
    `/projects/${projectId}/incidents/${incidentId}/affected-users`
  );
}

export function triggerFix(
  projectId: string,
  incidentId: string,
  guidance?: string
): Promise<{ job_id: string }> {
  return postJSON<{ job_id: string }>(
    `/projects/${projectId}/incidents/${incidentId}/fix`,
    guidance ? { guidance } : {}
  );
}

export function listAccounts(
  projectId: string,
  query?: string
): Promise<Account[]> {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  const qs = params.toString();
  return fetchJSON<Account[]>(
    `/projects/${projectId}/accounts${qs ? `?${qs}` : ''}`
  );
}

export function getAccount(
  projectId: string,
  accountId: string
): Promise<Account> {
  return fetchJSON<Account>(
    `/projects/${projectId}/accounts/${accountId}`
  );
}

export function listAccountIncidents(
  projectId: string,
  accountId: string
): Promise<Incident[]> {
  return fetchJSON<Incident[]>(
    `/projects/${projectId}/accounts/${accountId}/incidents`
  );
}

// === Incident lifecycle actions ===

export function resolveIncident(
  projectId: string,
  incidentId: string
): Promise<Incident> {
  return postJSON<Incident>(
    `/projects/${projectId}/incidents/${incidentId}/resolve`,
    {}
  );
}

export function archiveIncident(
  projectId: string,
  incidentId: string
): Promise<Incident> {
  return postJSON<Incident>(
    `/projects/${projectId}/incidents/${incidentId}/archive`,
    {}
  );
}

export function unarchiveIncident(
  projectId: string,
  incidentId: string
): Promise<Incident> {
  return postJSON<Incident>(
    `/projects/${projectId}/incidents/${incidentId}/unarchive`,
    {}
  );
}
