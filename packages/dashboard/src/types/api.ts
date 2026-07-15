export type ErrorGroupStatus =
  | 'new'
  | 'queued'
  | 'analyzing'
  | 'investigated'
  | 'fixing'
  | 'pr_created'
  | 'needs_human'
  | 'resolved'
  | 'merged'
  | 'archived';

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface NeedsHumanReason {
  reason_code: string;
  reason_message: string;
  remediation: string;
}

export interface Incident {
  id: string;
  project_id: string;
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
