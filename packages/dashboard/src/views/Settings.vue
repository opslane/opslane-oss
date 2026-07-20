<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  listProjects,
  createProject,
  updateProject,
  getFixStats,
  listEnvironments,
  createEnvironment,
  listAPIKeys,
  createAPIKey,
  getGitHubConfig,
  setGitHubConfig,
  deleteGitHubConfig,
  getGitHubAppStatus,
  getMe,
  type Project,
  type Environment,
  type APIKey,
  type APIKeyCreated,
  type FixStats,
  type ProjectProvisioningResponse,
} from '../api';
import type { AuthMembership, GitHubConfig, GitHubAppStatus } from '../types/api';
import { formatDate, safeUrl } from '../utils';
import CopyButton from '../components/CopyButton.vue';
import IntegrationsSettings from '../components/IntegrationsSettings.vue';
import RepoSelector from '../components/RepoSelector.vue';
import InvitationsPanel from '../components/InvitationsPanel.vue';
import {
  canDismissProvisionedKey,
  createProvisioningAttempt,
} from '../components/project-provisioning';
import {
  applyProjectSelection,
  projectSwitchQuery,
} from '../components/project-switcher';

type SettingsTab = 'project' | 'environments' | 'api-keys' | 'integrations' | 'organization';
const route = useRoute();
const router = useRouter();
const activeTab = ref<SettingsTab>('project');
const activeRole = ref<AuthMembership['role']>();
const activeRoleResolved = ref(false);

// Project tab
const projects = ref<Project[]>([]);
const selectedProjectId = ref(localStorage.getItem('opslane_project_id') ?? '');
const loadingProjects = ref(true);
const showNewProjectForm = ref(false);
const newProjectName = ref('');
const newProjectRepo = ref('');
const projectAttemptToken = ref('');
const creatingProject = ref(false);
const projectCreateError = ref('');
const provisionedProject = ref<ProjectProvisioningResponse | null>(null);
const provisioningKeyAcknowledged = ref(false);
const canProvision = computed(() =>
  !activeRole.value || activeRole.value === 'admin' || activeRole.value === 'owner',
);
const canManagePayloadEnvironment = computed(() =>
  activeRoleResolved.value
    && (!activeRole.value || activeRole.value === 'admin' || activeRole.value === 'owner'),
);

// Friction autonomy
const autonomyOptions = [
  {
    value: 'ask_first',
    label: 'Ask first (default)',
    description: 'Friction fixes wait in awaiting-approval until you click Generate fix.',
  },
  {
    value: 'auto_fix',
    label: 'Auto-fix',
    description: 'High-confidence, code-caused friction goes straight to a Suggestion PR.',
  },
  {
    value: 'auto_fix_ux',
    label: 'Auto-fix incl. UX suggestions',
    description: 'Same as auto-fix today; reserved for UX-suggestion fixes when they ship.',
  },
] as const;

const selectedProject = computed(() =>
  projects.value.find((project) => project.id === selectedProjectId.value) ?? null,
);
const activeProjectName = computed(() =>
  selectedProject.value?.name ?? localStorage.getItem('opslane_project_name') ?? 'No project selected',
);
const autonomy = ref<Project['friction_autonomy']>('ask_first');
const autonomySaving = ref(false);
const autonomyError = ref('');
const prPosture = ref<Project['pr_posture']>('verified_only');
const prPostureSaving = ref(false);
const prPostureError = ref('');
const allowPayloadEnvironment = ref(false);
const payloadEnvironmentSaving = ref(false);
const payloadEnvironmentError = ref('');
const fixStats = ref<Record<'error' | 'friction', FixStats> | null>(null);
let statsRequestToken = 0;
let autonomySaveToken = 0;
let prPostureSaveToken = 0;
let payloadEnvironmentSaveToken = 0;
let lastLoadedProjectId: string | null = null;

// Environments tab
const environments = ref<Environment[]>([]);
const loadingEnvs = ref(false);
const newEnvName = ref('');
const creatingEnv = ref(false);
const envError = ref('');

// API Keys tab
const apiKeys = ref<APIKey[]>([]);
const loadingKeys = ref(false);

// GitHub integration
const githubConfig = ref<GitHubConfig | null>(null);
const loadingGithub = ref(false);
const githubAppStatus = ref<GitHubAppStatus | null>(null);
const selectedRepo = ref('');
const connectingGithub = ref(false);
const disconnectingGithub = ref(false);
const githubError = ref('');

// New key modal
const showNewKeyModal = ref(false);
const newKeyEnvId = ref('');
const newKeyResult = ref<APIKeyCreated | null>(null);
const creatingKey = ref(false);
const keyError = ref('');

onMounted(async () => {
  getMe().then((user) => {
    activeRole.value = user.active_role;
    activeRoleResolved.value = true;
  }).catch(() => {});
  try {
    projects.value = await listProjects();
    // Load GitHub App status + per-project config
    loadGitHubAppStatus();
    if (selectedProjectId.value) {
      loadGitHubConfig(selectedProjectId.value);
    }
  } catch {
    // The active project remains available from local storage; project-scoped
    // requests below will surface their own failures.
  } finally {
    loadingProjects.value = false;
  }
});

watch(selectedProjectId, () => {
  // Invalidate an in-flight save for the previously selected project so its
  // completion cannot overwrite the new project's displayed state.
  autonomySaveToken += 1;
  autonomySaving.value = false;
  prPostureSaveToken += 1;
  prPostureSaving.value = false;
  payloadEnvironmentSaveToken += 1;
  payloadEnvironmentSaving.value = false;
  void loadAutonomyAndStats();
}, { immediate: true });
watch(projects, () => {
  // The projects list changes in two ways: the async load on mount (the
  // selected project appears — fetch its stats) and a completed save (same
  // project, only friction_autonomy changed — re-sync the toggle without
  // refetching stats, which would flicker the receipts for nothing).
  autonomy.value = selectedProject.value?.friction_autonomy ?? 'ask_first';
  prPosture.value = selectedProject.value?.pr_posture ?? 'verified_only';
  allowPayloadEnvironment.value = selectedProject.value?.allow_payload_environment ?? false;
  if ((selectedProject.value?.id ?? null) !== lastLoadedProjectId) {
    void loadAutonomyAndStats();
  }
});

async function loadAutonomyAndStats(): Promise<void> {
  const token = ++statsRequestToken;
  autonomyError.value = '';
  prPostureError.value = '';
  payloadEnvironmentError.value = '';
  fixStats.value = null;
  autonomy.value = selectedProject.value?.friction_autonomy ?? 'ask_first';
  prPosture.value = selectedProject.value?.pr_posture ?? 'verified_only';
  allowPayloadEnvironment.value = selectedProject.value?.allow_payload_environment ?? false;

  const id = selectedProjectId.value;
  lastLoadedProjectId = selectedProject.value?.id ?? null;
  if (!id || !selectedProject.value) return;

  try {
    const stats = await getFixStats(id);
    if (token === statsRequestToken) {
      fixStats.value = stats;
    }
  } catch {
    // Stats are best-effort; the autonomy setting works without them.
  }
}

function openNewProjectForm(): void {
  showNewProjectForm.value = true;
  projectCreateError.value = '';
  projectAttemptToken.value = createProvisioningAttempt(() => crypto.randomUUID()).idempotencyToken;
}

function cancelNewProjectForm(): void {
  if (creatingProject.value) return;
  showNewProjectForm.value = false;
  newProjectName.value = '';
  newProjectRepo.value = '';
  projectAttemptToken.value = '';
  projectCreateError.value = '';
}

async function handleCreateProject(): Promise<void> {
  if (!newProjectName.value.trim() || !projectAttemptToken.value || creatingProject.value) return;
  creatingProject.value = true;
  projectCreateError.value = '';
  try {
    const result = await createProject(
      newProjectName.value.trim(),
      newProjectRepo.value.trim(),
      projectAttemptToken.value,
    );
    provisionedProject.value = result;
    provisioningKeyAcknowledged.value = false;
    projects.value = [
      ...projects.value.filter((project) => project.id !== result.project.id),
      result.project,
    ];
    showNewProjectForm.value = false;
  } catch (caught: unknown) {
    projectCreateError.value = caught instanceof Error
      ? caught.message
      : 'Failed to create project';
  } finally {
    creatingProject.value = false;
  }
}

async function dismissProvisionedProject(): Promise<void> {
  if (!canDismissProvisionedKey(provisioningKeyAcknowledged.value)) return;
  const result = provisionedProject.value;
  if (!result) return;

  applyProjectSelection(localStorage, result.project);
  await router.push({ path: '/', query: projectSwitchQuery(route.query) });
  window.dispatchEvent(new Event('opslane-projects-changed'));

  provisionedProject.value = null;
  provisioningKeyAcknowledged.value = false;
  newProjectName.value = '';
  newProjectRepo.value = '';
  projectAttemptToken.value = '';
}

async function savePRPosture(value: Project['pr_posture']): Promise<void> {
  if (!selectedProject.value) return;

  const projectId = selectedProject.value.id;
  const saveToken = ++prPostureSaveToken;
  const previous = prPosture.value;
  prPosture.value = value;
  prPostureSaving.value = true;
  prPostureError.value = '';
  try {
    const updated = await updateProject(projectId, { pr_posture: value });
    projects.value = projects.value.map((project) =>
      project.id === updated.id ? updated : project,
    );
  } catch (err: unknown) {
    if (saveToken === prPostureSaveToken && selectedProjectId.value === projectId) {
      prPosture.value = previous;
      prPostureError.value = err instanceof Error
        ? err.message
        : 'Failed to save pull request posture';
    }
  } finally {
    if (saveToken === prPostureSaveToken) {
      prPostureSaving.value = false;
    }
  }
}

function onPRPostureChange(event: Event): void {
  const checked = event.target instanceof HTMLInputElement && event.target.checked;
  void savePRPosture(checked ? 'draft_when_unverified' : 'verified_only');
}

async function savePayloadEnvironment(value: boolean): Promise<void> {
  if (!selectedProject.value || !canManagePayloadEnvironment.value) return;

  const projectId = selectedProject.value.id;
  const saveToken = ++payloadEnvironmentSaveToken;
  const previous = allowPayloadEnvironment.value;
  allowPayloadEnvironment.value = value;
  payloadEnvironmentSaving.value = true;
  payloadEnvironmentError.value = '';
  try {
    const updated = await updateProject(projectId, { allow_payload_environment: value });
    projects.value = projects.value.map((project) =>
      project.id === updated.id ? updated : project,
    );
  } catch (err: unknown) {
    if (saveToken === payloadEnvironmentSaveToken && selectedProjectId.value === projectId) {
      allowPayloadEnvironment.value = previous;
      payloadEnvironmentError.value = err instanceof Error
        ? err.message
        : 'Failed to save SDK environment override setting';
    }
  } finally {
    if (saveToken === payloadEnvironmentSaveToken) {
      payloadEnvironmentSaving.value = false;
    }
  }
}

function onPayloadEnvironmentChange(event: Event): void {
  const checked = event.target instanceof HTMLInputElement && event.target.checked;
  void savePayloadEnvironment(checked);
}

async function saveAutonomy(value: Project['friction_autonomy']): Promise<void> {
  if (!selectedProject.value) return;

  const projectId = selectedProject.value.id;
  const saveToken = ++autonomySaveToken;
  const previous = autonomy.value;
  autonomy.value = value;
  autonomySaving.value = true;
  autonomyError.value = '';
  try {
    const updated = await updateProject(projectId, { friction_autonomy: value });
    projects.value = projects.value.map((project) =>
      project.id === updated.id ? updated : project,
    );
  } catch (err: unknown) {
    if (saveToken === autonomySaveToken && selectedProjectId.value === projectId) {
      autonomy.value = previous;
      autonomyError.value = err instanceof Error
        ? err.message
        : 'Failed to save autonomy setting';
    }
  } finally {
    if (saveToken === autonomySaveToken) {
      autonomySaving.value = false;
    }
  }
}

function optionStats(value: Project['friction_autonomy']): string {
  const stats = fixStats.value?.friction;
  if (!stats) return '';

  switch (value) {
    case 'ask_first':
      return `${stats.generated_human} friction fixes requested by you`;
    case 'auto_fix':
      // Attempts, not delivered PRs: a job can park or dead-end before a PR.
      // The merged/closed splits count auto-triggered PRs only.
      return `${stats.generated_auto} auto fix attempts · ${stats.prs_merged_auto} merged · ${stats.prs_closed_auto} closed without merge`;
    case 'auto_fix_ux':
      return 'Shares the auto-fix path today — activity is counted under Auto-fix';
  }
}

function switchTab(tab: SettingsTab): void {
  activeTab.value = tab;
  const pid = selectedProjectId.value || localStorage.getItem('opslane_project_id') || '';
  if (tab === 'environments' && environments.value.length === 0 && pid) {
    loadEnvironments(pid);
  }
  if (tab === 'api-keys' && apiKeys.value.length === 0 && pid) {
    loadAPIKeys(pid);
  }
}

async function loadEnvironments(pid: string): Promise<void> {
  loadingEnvs.value = true;
  try {
    environments.value = (await listEnvironments(pid)).environments;
  } catch {
    // Non-fatal
  } finally {
    loadingEnvs.value = false;
  }
}

async function handleCreateEnvironment(): Promise<void> {
  const pid = selectedProjectId.value || localStorage.getItem('opslane_project_id') || '';
  if (!pid || !newEnvName.value.trim()) return;
  creatingEnv.value = true;
  envError.value = '';
  try {
    const env = await createEnvironment(pid, newEnvName.value.trim());
    environments.value.push(env);
    newEnvName.value = '';
  } catch (err: unknown) {
    envError.value = err instanceof Error ? err.message : 'Failed to create environment';
  } finally {
    creatingEnv.value = false;
  }
}

async function loadAPIKeys(pid: string): Promise<void> {
  loadingKeys.value = true;
  try {
    apiKeys.value = await listAPIKeys(pid);
  } catch {
    // Non-fatal
  } finally {
    loadingKeys.value = false;
  }
}

function openNewKeyModal(): void {
  newKeyResult.value = null;
  keyError.value = '';
  // Pre-select first environment if available
  if (environments.value.length > 0) {
    newKeyEnvId.value = environments.value[0].id;
  }
  showNewKeyModal.value = true;
}

async function loadGitHubConfig(pid: string): Promise<void> {
  loadingGithub.value = true;
  try {
    githubConfig.value = await getGitHubConfig(pid);
  } catch {
    // Non-fatal
  } finally {
    loadingGithub.value = false;
  }
}

async function loadGitHubAppStatus(): Promise<void> {
  try {
    githubAppStatus.value = await getGitHubAppStatus();
  } catch {
    // Non-fatal
  }
}

async function handleConnectGithub(): Promise<void> {
  const pid = selectedProjectId.value || localStorage.getItem('opslane_project_id') || '';
  if (!pid || !selectedRepo.value) return;
  connectingGithub.value = true;
  githubError.value = '';
  try {
    githubConfig.value = await setGitHubConfig(pid, {
      github_repo: selectedRepo.value,
    });
    selectedRepo.value = '';
  } catch (err: unknown) {
    githubError.value = err instanceof Error ? err.message : 'Failed to connect GitHub';
  } finally {
    connectingGithub.value = false;
  }
}

async function handleDisconnectGithub(): Promise<void> {
  const pid = selectedProjectId.value || localStorage.getItem('opslane_project_id') || '';
  if (!pid) return;
  disconnectingGithub.value = true;
  try {
    await deleteGitHubConfig(pid);
    githubConfig.value = null;
  } catch {
    // Non-fatal
  } finally {
    disconnectingGithub.value = false;
  }
}

async function handleCreateKey(): Promise<void> {
  if (!newKeyEnvId.value) return;
  creatingKey.value = true;
  keyError.value = '';
  try {
    newKeyResult.value = await createAPIKey(newKeyEnvId.value);
    // Refresh key list
    const pid = selectedProjectId.value || localStorage.getItem('opslane_project_id') || '';
    if (pid) {
      apiKeys.value = await listAPIKeys(pid);
    }
  } catch (err: unknown) {
    keyError.value = err instanceof Error ? err.message : 'Failed to create API key';
  } finally {
    creatingKey.value = false;
  }
}
</script>

<template>
  <div class="max-w-3xl">
    <h2 class="text-lg font-medium text-text mb-4">Settings</h2>

    <!-- Tabs -->
    <div class="border-b border-border mb-6 pb-3">
      <nav class="flex gap-2">
        <button
          class="text-sm font-medium transition-colors"
          :class="activeTab === 'project' ? 'tab-active' : 'tab-inactive'"
          @click="switchTab('project')"
        >
          Project
        </button>
        <button
          class="text-sm font-medium transition-colors"
          :class="activeTab === 'environments' ? 'tab-active' : 'tab-inactive'"
          @click="switchTab('environments')"
        >
          Environments
        </button>
        <button
          class="text-sm font-medium transition-colors"
          :class="activeTab === 'api-keys' ? 'tab-active' : 'tab-inactive'"
          @click="switchTab('api-keys')"
        >
          API Keys
        </button>
        <button
          class="text-sm font-medium transition-colors"
          :class="activeTab === 'integrations' ? 'tab-active' : 'tab-inactive'"
          @click="switchTab('integrations')"
        >
          Integrations
        </button>
        <button
          v-if="activeRole"
          class="text-sm font-medium transition-colors"
          :class="activeTab === 'organization' ? 'tab-active' : 'tab-inactive'"
          @click="switchTab('organization')"
        >
          Organization
        </button>
      </nav>
    </div>

    <!-- Project tab -->
    <div v-if="activeTab === 'project'" class="max-w-lg">
      <p class="text-sm text-text-muted mb-6">
        Configure your active project. This determines which project's incidents you
        see in the activity feed.
      </p>

      <div v-if="canProvision" class="mb-6">
        <button
          v-if="!showNewProjectForm"
          type="button"
          class="btn-primary"
          @click="openNewProjectForm"
        >
          New project
        </button>
        <form
          v-else
          class="space-y-3 rounded-lg border border-border bg-surface p-4"
          @submit.prevent="handleCreateProject"
        >
          <h3 class="text-sm font-medium text-text">Create project</h3>
          <label class="block text-xs text-text-muted">
            Name
            <input
              v-model="newProjectName"
              name="new-project-name"
              class="mt-1 block w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text"
              maxlength="100"
              required
            />
          </label>
          <label class="block text-xs text-text-muted">
            GitHub repository (optional)
            <input
              v-model="newProjectRepo"
              name="new-project-repo"
              placeholder="owner/repository"
              class="mt-1 block w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text"
            />
          </label>
          <p v-if="projectCreateError" class="text-sm text-red" v-text="projectCreateError"></p>
          <div class="flex gap-3">
            <button
              type="submit"
              class="btn-primary"
              :disabled="creatingProject || !newProjectName.trim()"
            >
              {{ creatingProject ? 'Creating...' : 'Create project' }}
            </button>
            <button type="button" class="btn-secondary" :disabled="creatingProject" @click="cancelNewProjectForm">
              Cancel
            </button>
          </div>
        </form>
      </div>

      <div v-if="loadingProjects" class="text-sm text-text-muted">Loading projects...</div>

      <div v-else class="rounded-lg border border-border bg-surface p-4">
        <div class="text-xs font-medium uppercase tracking-wide text-text-muted">Active project</div>
        <div class="mt-1 text-sm font-medium text-text">
          {{ activeProjectName }}
        </div>
        <p class="mt-2 text-xs text-text-muted">
          Use the project switcher in the header to change projects safely.
        </p>
      </div>

      <!-- GitHub Integration -->
      <div class="mt-8 pt-6 border-t border-border">
        <h3 class="text-sm font-medium text-text mb-1">GitHub Integration</h3>
        <p class="text-sm text-text-muted mb-3">
          Install the Opslane GitHub App and select a repository to enable automated fix PRs.
        </p>

        <div v-if="loadingGithub" class="text-sm text-text-muted">Loading...</div>

        <!-- GitHub App not installed -->
        <div v-else-if="!githubAppStatus?.installed" class="space-y-3">
          <p class="text-sm text-text-muted">
            The Opslane GitHub App needs to be installed on your organization to access repositories.
          </p>
          <a
            v-if="githubAppStatus?.install_url"
            :href="safeUrl(githubAppStatus.install_url)"
            class="inline-flex items-center gap-2 btn-secondary"
          >
            <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M10 0C4.477 0 0 4.477 0 10c0 4.42 2.865 8.166 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.564 9.564 0 0110 4.844c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C17.137 18.163 20 14.418 20 10c0-5.523-4.477-10-10-10z" clip-rule="evenodd" />
            </svg>
            Install GitHub App
          </a>
        </div>

        <!-- GitHub App installed -->
        <div v-else class="space-y-4">
          <div class="flex items-center gap-2">
            <span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-green/10 text-green">
              GitHub App installed
            </span>
          </div>

          <div class="rounded-md border border-amber/20 bg-amber/10 p-3 text-xs text-amber">
            Draft PR verification requires the GitHub App's <strong>Checks: read</strong>
            permission. If you installed the App before this permission was added, approve
            the permission upgrade in GitHub. Until then, drafts stay drafts and show a
            permission warning instead of being promoted automatically.
          </div>

          <!-- Repo connected -->
          <div v-if="githubConfig?.connected" class="space-y-3">
            <div class="flex items-center gap-3">
              <span class="text-sm text-text-muted">Repository:</span>
              <span class="text-sm text-text font-mono" v-text="githubConfig.github_repo"></span>
            </div>
            <button
              @click="handleDisconnectGithub"
              :disabled="disconnectingGithub"
              class="rounded-md bg-red/10 px-3 py-1.5 text-sm font-medium text-red hover:bg-red/20 focus:outline-none focus:ring-2 focus:ring-red focus:ring-offset-2 focus:ring-offset-background disabled:opacity-50"
            >
              {{ disconnectingGithub ? 'Disconnecting...' : 'Disconnect repo' }}
            </button>
          </div>

          <!-- Repo not connected — show selector -->
          <div v-else class="space-y-3">
            <div>
              <label class="block text-sm font-medium text-text-muted mb-1">Repository</label>
              <RepoSelector v-model="selectedRepo" />
            </div>
            <div v-if="githubError" class="text-sm text-red" v-text="githubError"></div>
            <button
              @click="handleConnectGithub"
              :disabled="connectingGithub || !selectedRepo"
              class="btn-primary"
            >
              {{ connectingGithub ? 'Connecting...' : 'Connect repository' }}
            </button>
          </div>
        </div>
      </div>

      <!-- Pull request posture -->
      <section class="mt-8 p-4 bg-surface border border-border rounded-lg space-y-3">
        <div class="flex items-start justify-between gap-4">
          <div>
            <h3 id="pr-posture-heading" class="text-sm font-medium text-text">Draft PRs for unverified fixes</h3>
            <p id="pr-posture-desc" class="mt-1 text-xs text-text-muted">
              When enabled, a judge-approved fix with a passing build and no negative test
              evidence can be published as a clearly labeled draft. Repository CI must pass
              before Opslane marks it ready for review.
            </p>
          </div>
          <label class="relative inline-flex shrink-0 cursor-pointer items-center">
            <input
              type="checkbox"
              class="peer sr-only"
              role="switch"
              aria-labelledby="pr-posture-heading"
              aria-describedby="pr-posture-desc"
              :checked="prPosture === 'draft_when_unverified'"
              :disabled="!selectedProject || prPostureSaving"
              @change="onPRPostureChange"
            />
            <span class="h-6 w-11 rounded-full bg-text-faint transition-colors peer-checked:bg-teal peer-disabled:cursor-not-allowed peer-disabled:opacity-50 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-5"></span>
          </label>
        </div>
        <p v-if="!selectedProject" class="text-xs text-text-faint">
          Select one of your projects above to manage draft PR delivery.
          (Manually entered project IDs can't be managed here.)
        </p>
        <p v-else class="text-xs text-text-faint">
          {{ prPosture === 'draft_when_unverified'
            ? 'Enabled — eligible unverified fixes may open as drafts.'
            : 'Verified only (default) — fixes below the ready bar remain needs-human incidents.' }}
        </p>
        <p v-if="prPostureError" class="text-sm text-red" v-text="prPostureError"></p>
      </section>

      <!-- SDK-provided environment override -->
      <section class="mt-8 p-4 bg-surface border border-border rounded-lg space-y-3">
        <div class="flex items-start justify-between gap-4">
          <div>
            <h3 id="payload-environment-heading" class="text-sm font-medium text-text">
              Allow SDK environment override
            </h3>
            <p id="payload-environment-desc" class="mt-1 text-xs text-text-muted">
              This relaxes the boundary provided by an environment-bound API key. SDK event
              and replay payloads may select any existing environment in this project. Enable
              it only when you trust clients to choose the correct environment.
            </p>
          </div>
          <label class="relative inline-flex shrink-0 items-center" :class="canManagePayloadEnvironment ? 'cursor-pointer' : 'cursor-not-allowed'">
            <input
              type="checkbox"
              class="peer sr-only"
              role="switch"
              aria-labelledby="payload-environment-heading"
              aria-describedby="payload-environment-desc"
              :checked="allowPayloadEnvironment"
              :disabled="!selectedProject || !canManagePayloadEnvironment || payloadEnvironmentSaving"
              @change="onPayloadEnvironmentChange"
            />
            <span class="h-6 w-11 rounded-full bg-text-faint transition-colors peer-checked:bg-teal peer-disabled:cursor-not-allowed peer-disabled:opacity-50 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-5"></span>
          </label>
        </div>
        <p v-if="!selectedProject" class="text-xs text-text-faint">
          Select one of your projects above to manage SDK environment overrides.
        </p>
        <p v-else-if="!canManagePayloadEnvironment" class="text-xs text-text-faint">
          Only organization admins can change this setting.
        </p>
        <p v-else class="text-xs text-text-faint">
          {{ allowPayloadEnvironment
            ? 'Enabled — SDK payloads may override the key-bound environment.'
            : 'Disabled (default) — the API key always determines the environment.' }}
        </p>
        <p v-if="payloadEnvironmentError" class="text-sm text-red" v-text="payloadEnvironmentError"></p>
      </section>

      <!-- Friction autonomy (Batch 5, issue #57) -->
      <section class="mt-8 p-4 bg-surface border border-border rounded-lg space-y-3">
        <div>
          <h3 id="friction-autonomy-heading" class="text-sm font-medium text-text">Friction autonomy</h3>
          <p id="friction-autonomy-desc" class="mt-1 text-xs text-text-muted">
            How Opslane acts on friction incidents (rage clicks, dead clicks, form abandonment)
            that have a code cause. Error fixes are unaffected.
          </p>
        </div>
        <p v-if="!selectedProject" class="text-xs text-text-faint">
          Select one of your projects above to manage autonomy.
          (Manually entered project IDs can't be managed here.)
        </p>
        <div
          v-else
          class="space-y-2"
          role="radiogroup"
          aria-labelledby="friction-autonomy-heading"
          aria-describedby="friction-autonomy-desc"
        >
          <label
            v-for="option in autonomyOptions"
            :key="option.value"
            class="flex items-start gap-3 p-3 border rounded-lg transition-colors focus-within:ring-1 focus-within:ring-teal"
            :class="[
              autonomy === option.value
                ? 'border-teal bg-teal/5'
                : 'border-border hover:border-text-faint hover:bg-surface-2',
              autonomySaving ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer',
            ]"
          >
            <input
              type="radio"
              name="friction-autonomy"
              class="mt-0.5"
              :value="option.value"
              :checked="autonomy === option.value"
              :disabled="autonomySaving"
              @change="saveAutonomy(option.value)"
            />
            <span>
              <span class="block text-sm text-text" v-text="option.label"></span>
              <span class="block text-xs text-text-muted" v-text="option.description"></span>
              <span
                v-if="fixStats"
                class="block mt-1 text-xs text-text-faint"
                v-text="optionStats(option.value)"
              ></span>
            </span>
          </label>
        </div>
        <p v-if="autonomyError" class="text-sm text-red" v-text="autonomyError"></p>
      </section>
    </div>

    <!-- Environments tab -->
    <div v-if="activeTab === 'environments'">
      <div v-if="loadingEnvs" class="text-sm text-text-muted">Loading environments...</div>

      <div v-else>
        <ul v-if="environments.length > 0" class="space-y-2 mb-6">
          <li
            v-for="env in environments"
            :key="env.id"
            class="flex items-center justify-between bg-surface rounded-lg border border-border px-4 py-3"
          >
            <div>
              <span class="text-sm font-medium text-text" v-text="env.name"></span>
              <span class="ml-2 text-xs text-text-muted">created {{ formatDate(env.created_at) }}</span>
            </div>
          </li>
        </ul>
        <div v-else class="text-sm text-text-muted mb-6">No environments yet.</div>

        <form @submit.prevent="handleCreateEnvironment" class="flex gap-3">
          <input
            v-model="newEnvName"
            type="text"
            placeholder="Environment name (e.g. staging)"
            :disabled="creatingEnv"
            class="flex-1 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text focus:border-teal focus:ring-1 focus:ring-teal disabled:opacity-50"
          />
          <button
            type="submit"
            :disabled="creatingEnv || !newEnvName.trim()"
            class="btn-primary"
          >
            {{ creatingEnv ? 'Creating...' : 'Create environment' }}
          </button>
        </form>
        <div v-if="envError" class="mt-2 text-sm text-red" v-text="envError"></div>
      </div>
    </div>

    <!-- API Keys tab -->
    <div v-if="activeTab === 'api-keys'">
      <div v-if="loadingKeys" class="text-sm text-text-muted">Loading API keys...</div>

      <div v-else>
        <div v-if="apiKeys.length > 0" class="border border-border rounded-lg overflow-hidden mb-6">
          <table class="min-w-full text-sm">
            <thead>
              <tr class="border-b border-border bg-surface">
                <th class="py-2.5 px-4 text-left text-xs font-medium text-text-muted uppercase tracking-wider">Prefix</th>
                <th class="py-2.5 px-4 text-left text-xs font-medium text-text-muted uppercase tracking-wider">Environment</th>
                <th class="py-2.5 px-4 text-left text-xs font-medium text-text-muted uppercase tracking-wider">Created</th>
                <th class="py-2.5 px-4 text-left text-xs font-medium text-text-muted uppercase tracking-wider">Status</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="key in apiKeys"
                :key="key.id"
                class="border-b border-border-subtle hover:bg-surface transition-colors"
              >
                <td class="py-2.5 px-4 font-mono text-xs" v-text="key.key_prefix"></td>
                <td class="py-2.5 px-4" v-text="key.environment_name"></td>
                <td class="py-2.5 px-4 whitespace-nowrap">{{ formatDate(key.created_at) }}</td>
                <td class="py-2.5 px-4">
                  <span
                    class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                    :class="key.revoked_at
                      ? 'bg-red/10 text-red'
                      : 'bg-green/10 text-green'"
                  >
                    {{ key.revoked_at ? 'Revoked' : 'Active' }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="text-sm text-text-muted mb-6">No API keys yet.</div>

        <button
          @click="openNewKeyModal"
          class="btn-primary"
        >
          Generate new key
        </button>
      </div>
    </div>

    <div v-if="activeTab === 'organization'">
      <InvitationsPanel :active-role="activeRole" />
    </div>

    <IntegrationsSettings
      v-if="activeTab === 'integrations'"
      :project-id="selectedProjectId"
    />

    <!-- One-time project provisioning key -->
    <div
      v-if="provisionedProject"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    >
      <div class="bg-surface rounded-lg border border-border max-w-lg w-full mx-4 p-6">
        <h3 class="text-lg font-medium text-text">Project created</h3>
        <p class="mt-1 text-sm text-text-muted">
          The production environment is ready. Save this API key now; it cannot be shown again.
        </p>
        <div class="mt-4 rounded-lg bg-surface-2 text-text p-4 font-mono text-sm break-all relative">
          <span v-text="provisionedProject.api_key.raw_key"></span>
          <div class="absolute top-2 right-2">
            <CopyButton :text="provisionedProject.api_key.raw_key" />
          </div>
        </div>
        <label class="mt-4 flex items-start gap-2 text-sm text-text-muted">
          <input v-model="provisioningKeyAcknowledged" type="checkbox" class="mt-0.5" />
          <span>I have copied and stored this key securely.</span>
        </label>
        <button
          type="button"
          class="mt-4 w-full btn-primary"
          :disabled="!canDismissProvisionedKey(provisioningKeyAcknowledged)"
          @click="dismissProvisionedProject"
        >
          Done
        </button>
      </div>
    </div>

    <!-- New key modal -->
    <div
      v-if="showNewKeyModal"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      @click.self="showNewKeyModal = false"
    >
      <div class="bg-surface rounded-lg border border-border max-w-md w-full mx-4 p-6">
        <h3 class="text-lg font-medium text-text mb-4">
          {{ newKeyResult ? 'API key created' : 'Generate new API key' }}
        </h3>

        <!-- Key created view -->
        <div v-if="newKeyResult">
          <div class="rounded-lg bg-surface-2 text-text p-4 font-mono text-sm break-all relative">
            <span v-text="newKeyResult.raw_key"></span>
            <div class="absolute top-2 right-2">
              <CopyButton :text="newKeyResult.raw_key" />
            </div>
          </div>
          <div class="mt-3 rounded-md bg-amber/10 border border-amber/20 p-3">
            <p class="text-sm text-amber">
              Save this key -- you won't see it again.
            </p>
          </div>
          <button
            @click="showNewKeyModal = false"
            class="mt-4 w-full btn-secondary"
          >
            Done
          </button>
        </div>

        <!-- Environment selector -->
        <div v-else>
          <div v-if="environments.length === 0" class="text-sm text-text-muted mb-4">
            Create an environment first in the Environments tab.
          </div>
          <div v-else class="space-y-4">
            <div>
              <label for="key-env-select" class="block text-sm font-medium text-text-muted">
                Environment
              </label>
              <select
                id="key-env-select"
                v-model="newKeyEnvId"
                class="mt-1 block w-full rounded-md px-3 py-2 text-sm"
              >
                <option
                  v-for="env in environments"
                  :key="env.id"
                  :value="env.id"
                  v-text="env.name"
                ></option>
              </select>
            </div>
            <div v-if="keyError" class="text-sm text-red" v-text="keyError"></div>
            <div class="flex gap-3">
              <button
                @click="handleCreateKey"
                :disabled="creatingKey || !newKeyEnvId"
                class="flex-1 btn-primary"
              >
                {{ creatingKey ? 'Generating...' : 'Generate key' }}
              </button>
              <button
                @click="showNewKeyModal = false"
                class="btn-secondary"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
