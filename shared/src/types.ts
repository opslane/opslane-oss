// === Tenant model ===

export interface Org {
  id: string;
  name: string;
  created_at: string;
}

export interface Project {
  id: string;
  org_id: string;
  name: string;
  github_repo: string;
  default_branch: string;
  created_at: string;
}

export interface Environment {
  id: string;
  project_id: string;
  name: string; // e.g. "production", "staging"
  created_at: string;
}

// === User (session auth) ===

export interface User {
  id: string;
  org_id: string;
  email: string;
  name: string;
  created_at: string;
}

// === SDK → Ingestion payload ===

export interface ErrorEventPayload {
  timestamp: string; // ISO 8601
  error: {
    type: string;
    message: string;
    stack: string;
  };
  breadcrumbs: Breadcrumb[];
  context: {
    url?: string;
    user_agent?: string;
    user?: {
      id: string;
      email?: string;
      account_id?: string;
      account_name?: string;
    };
  };
  sdk_version: string;
  release?: string;      // source map lookup
  session_id?: string;   // links error event to replay
}

export interface Breadcrumb {
  type: BreadcrumbType;
  timestamp: string;
  category: string;
  message: string;
  data?: Record<string, unknown>;
  level?: 'debug' | 'info' | 'warning' | 'error';
}

export type BreadcrumbType =
  | 'error'
  | 'fetch'
  | 'xhr'
  | 'console'
  | 'click'
  | 'navigation';

// === Error group statuses ===

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
  | 'archived'
  // Friction lifecycle (epic #31 Batch 3, design v4-4/v4-10):
  | 'candidate' // Adjudication pending; hidden from every list/read API.
  | 'awaiting_approval' // Code cause found; parked for a human; fix-eligible.
  | 'insight'; // No code cause; terminal; never becomes a PR.

// === Reason contract for needs_human ===

export interface NeedsHumanReason {
  reason_code: ReasonCode;
  reason_message: string;
  remediation: string;
}

export type ReasonCode =
  | 'missing_github_token'
  | 'repo_access_denied'
  | 'token_decrypt_failed'
  | 'auth_invalid'
  | 'policy_blocked'
  | 'missing_llm_key'
  | 'malformed_diff'
  | 'verification_failed'
  | 'sourcemap_unresolved'
  | 'artifact_fetch_failed'
  | 'insufficient_context'
  | 'worker_runtime_error'
  | 'lease_lost'
  | 'budget_exhausted'
  | 'tests_failed'
  | 'low_confidence_fix'
  | 'triage_unfixable'
  | 'unfixable_no_app_frames'
  | 'unfixable_test_error'
  | 'unfixable_third_party'
  | 'unfixable_infra'
  | 'unfixable_no_sourcemap';

// === Confidence ===

export type ConfidenceLevel = 'high' | 'medium' | 'low';

// === Incident (read API response) ===

export type IncidentKind = 'error' | 'friction';
export type FrictionSignalType = 'rage_click' | 'dead_click' | 'form_abandon';

export interface Incident {
  id: string;
  project_id: string;
  kind: IncidentKind;
  fingerprint: string;
  title: string;
  status: ErrorGroupStatus;
  first_seen: string;
  last_seen: string;
  occurrence_count: number;
  affected_users_count: number;
  confidence?: ConfidenceLevel;
  pr_url?: string;
  replay_id?: string;
  /** Pointer into the always-on recording for this incident occurrence. */
  session_pointer?: { session_id: string; error_at: string };
  reason?: NeedsHumanReason;
  root_cause?: string;
  visual_summary?: string;
  merged_at?: string;
  resolved_at?: string;
  archived_at?: string;
}

// === Source map upload ===

export interface SourceMapUpload {
  version: string;
  files: SourceMapFile[];
}

export interface SourceMapFile {
  file_path: string;
  source_map: string;
}

// === B2B customer-scoped tracking ===

export interface EndUser {
  id: string;
  project_id: string;
  external_user_id: string;
  external_account_id?: string;
  email?: string;
  display_name?: string;
  first_seen: string;
  last_seen: string;
}

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

export type JobType = 'error_fix' | 'investigate' | 'fix' | 'setup_pr' | 'session_analysis';

// === Session chunk wire format ===
// Keep wire-compatible with packages/sdk/src/telemetry.ts and
// packages/sdk/src/chunk-upload.ts. The SDK intentionally keeps local types to
// avoid taking a dependency on this package.

export type SessionTelemetryEvent =
  | { kind: 'click'; clickId: string; selector: string; cursor: string; at: number }
  | { kind: 'request_start'; requestId: string; clickId: string | null; method: string; url: string; at: number }
  | { kind: 'request_end'; requestId: string; status: number; at: number }
  | { kind: 'form_submit'; selector: string; at: number };

/**
 * Decompressed `session_chunks` object body. `events` are raw rrweb
 * `eventWithTime` entries; telemetry rides as rrweb custom events (top-level
 * `type === 5`, `data.tag === 'opslane.telemetry'`, and `data.payload` matches
 * {@link SessionTelemetryEvent}).
 */
export interface SessionChunkEnvelope {
  events: unknown[];
  meta: {
    sdk_version: string;
    has_full_snapshot: boolean;
    chunked_at: number;
  };
}

/** Status of the one-time "install Opslane SDK" PR for a project. */
export type SetupPrStatus =
  | 'pending'
  | 'opening'
  | 'open'
  | 'already_installed'
  | 'failed';
