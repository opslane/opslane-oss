export interface AuthMembership {
  org_id: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
}

export interface AuthUser {
  id: string;
  org_id: string;
  active_org_id?: string;
  active_role?: AuthMembership['role'];
  email: string;
  name: string;
  is_admin: boolean;
  memberships?: AuthMembership[];
}

export interface AuthConfig {
  provider: string;
  supports_password: boolean;
  supports_signup: boolean;
  supports_reset: boolean;
}

export type PasswordAuthResult =
  | { status: 'authenticated'; user: AuthUser }
  | { status: 'email_verification_required'; pending_authentication_token: string }
  | { status: 'error'; code: number; message: string };

export type ResetPasswordResult =
  | { status: 'reset' }
  | { status: 'error'; code: number; message: string };

export type ForgotPasswordResult =
  | { status: 'sent' }
  | { status: 'error'; code: number; message: string };

export interface OrgInvitation {
  id: string;
  org_id: string;
  email: string;
  role: AuthMembership['role'];
  invited_by: string;
  expires_at: string;
  created_at: string;
  accepted_at?: string;
  revoked_at?: string;
}

export type ErrorGroupStatus =
  | 'new'
  | 'queued'
  | 'analyzing'
  | 'investigated'
  | 'fixing'
  | 'pr_draft'
  | 'pr_created'
  | 'needs_human'
  | 'resolved'
  | 'merged'
  | 'archived'
  | 'candidate'
  | 'awaiting_approval'
  | 'insight';

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface NeedsHumanReason {
  reason_code: string;
  reason_message: string;
  remediation: string;
}

export type CheckOutcome = 'passed' | 'failed' | 'skipped_no_runner' | 'infra_error';

export interface EvidenceCheck {
  name: string;
  outcome: CheckOutcome;
  command: string;
  exit_code?: number;
  output_tail: string;
}

export interface EvidenceRecord {
  version: 1 | 2;
  tier: 'E0' | 'E1' | 'E2' | null;
  checks: EvidenceCheck[];
  suite?: {
    baseline_failed_tests: string[];
    new_failures: string[];
  };
  external_ci?: {
    outcome: 'passed' | 'failed' | 'no_ci_observed' | 'head_moved' | 'permission_denied';
    pr_number: number;
    head_sha: string;
    check_names: string[];
    failing_checks?: string[];
    observed_at: string;
  };
}

export interface Incident {
  id: string;
  project_id: string;
  kind: 'error' | 'friction';
  /** Present only on kind='friction': friction identity is environment-scoped. */
  environment_id?: string;
  /** Present only on kind='friction'; 'unchecked' flags an exhausted,
   * non-fixable adjudication diagnostic. */
  adjudication_status?: 'pending' | 'accepted' | 'rejected' | 'unchecked';
  fingerprint: string;
  title: string;
  status: ErrorGroupStatus;
  first_seen: string;
  last_seen: string;
  occurrence_count: number;
  affected_users_count: number;
  confidence?: ConfidenceLevel;
  pr_url?: string;
  reason?: NeedsHumanReason;
  verification_evidence?: EvidenceRecord;
  candidate_diff?: string;
  root_cause?: string;
  suggested_mitigation?: string;
  merged_at?: string;
  resolved_at?: string;
  archived_at?: string;
  trace_url?: string;
  replay_id?: string; // Project D: rrweb replay correlation
  session_pointer?: {
    session_id: string;
    error_at: string;
  };
}

// === Session replay browsing ===

export type SessionStatus =
  | 'recording'
  | 'closed'
  | 'analyzing'
  | 'analyzed'
  | 'analysis_failed'
  | 'deleting';

export interface SessionEndUser {
  id: string;
  external_user_id?: string | null;
  email?: string | null;
  external_account_id?: string | null;
  account_name?: string | null;
}

export interface SessionSummary {
  id: string;
  started_at: string;
  last_chunk_at?: string | null;
  status: SessionStatus;
  chunk_count: number;
  playable_chunk_count: number;
  bytes_stored: number;
  page_url?: string | null;
  end_user?: SessionEndUser | null;
}

export interface SessionChunkMeta {
  seq: number;
  size_bytes?: number | null;
  decoded_size_bytes?: number | null;
  has_full_snapshot: boolean;
  first_event_ms?: number | null;
  last_event_ms?: number | null;
}

export interface SessionDetail extends SessionSummary {
  chunks: SessionChunkMeta[];
}

export interface SessionListResponse {
  sessions: SessionSummary[];
  next_cursor?: string | null;
}

export interface SessionFilters {
  end_user_id?: string;
  account_id?: string;
  from?: string;
  to?: string;
  limit?: number;
}

// === B2B types ===

export interface AffectedUser {
  end_user_id: string;
  external_user_id: string;
  email?: string;
  external_account_id?: string;
  first_seen: string;
  last_seen: string;
  occurrence_count: number;
}

export interface Account {
  external_account_id: string;
  account_name?: string;
  user_count: number;
  incident_count: number;
  last_seen: string;
}

export interface IncidentFilters {
  account_id?: string;
  end_user_id?: string;
  status?: string;
}

// === GitHub integration ===

export interface GitHubConfig {
  github_repo: string;
  connected: boolean;
}

export interface GitHubAppStatus {
  installed: boolean;
  installation_id: number | null;
  install_url: string;
}

export interface GitHubRepo {
  full_name: string;
  private: boolean;
  default_branch: string;
}

export interface SetupPrStatus {
  status: '' | 'pending' | 'opening' | 'open' | 'already_installed' | 'failed';
  pr_url: string | null;
  pr_number: number | null;
  error?: string;
}

// === Admin observability ===

export type AdminJobStatus =
  | 'pending'
  | 'claimed'
  | 'completed'
  | 'failed'
  | 'dead_letter';

export type AdminJobType =
  | 'investigate'
  | 'fix'
  | 'error_fix'
  | 'setup_pr'
  | 'ci_watch'
  | 'session_analysis';

export interface AdminHourlyEventBucket {
  hour: string;
  count: number;
}

export interface AdminTopProject {
  project_id: string;
  project_name: string;
  org_name: string;
  count: number;
}

export interface AdminOverview {
  events: {
    last_1h: number;
    last_24h: number;
    last_7d: number;
    hourly: AdminHourlyEventBucket[];
    top_projects: AdminTopProject[];
  };
  jobs: {
    by_status: Partial<Record<AdminJobStatus, number>>;
    by_type: Partial<Record<AdminJobType, number>>;
    oldest_pending_age_seconds: number | null;
    dead_letters_7d: number;
  };
  workers: {
    live_claims: number;
    active_5m: number;
  };
  outcomes: {
    by_status: Record<string, number>;
    pr_created_24h: number;
    pr_created_7d: number;
    needs_human_7d: number;
    merged_7d: number;
    closed_7d: number;
  };
}

export interface AdminJob {
  id: string;
  project_name: string;
  job_type: AdminJobType;
  status: AdminJobStatus;
  attempts: number;
  created_at: string;
  duration_seconds: number | null;
  last_error: string | null;
  trace_url: string | null;
  incident_title: string | null;
  pr_url: string | null;
}

export interface AdminJobsResponse {
  jobs: AdminJob[];
}

export interface HealthCheckResult {
  status: string;
  latency_ms?: number;
  error?: string;
}

export interface HealthResponse {
  status: string;
  checks: Record<string, HealthCheckResult>;
  version: string;
  uptime_seconds: number;
}
