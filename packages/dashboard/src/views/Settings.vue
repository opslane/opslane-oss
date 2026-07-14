<script setup lang="ts">
import { ref, onMounted } from 'vue';
import {
  listProjects,
  listEnvironments,
  createEnvironment,
  listAPIKeys,
  createAPIKey,
  getGitHubConfig,
  setGitHubConfig,
  deleteGitHubConfig,
  getGitHubAppStatus,
  type Project,
  type Environment,
  type APIKey,
  type APIKeyCreated,
} from '../api';
import type { GitHubConfig, GitHubAppStatus } from '../types/api';
import { formatDate, safeUrl } from '../utils';
import CopyButton from '../components/CopyButton.vue';
import RepoSelector from '../components/RepoSelector.vue';

const activeTab = ref<'project' | 'environments' | 'api-keys'>('project');

// Project tab
const projects = ref<Project[]>([]);
const selectedProjectId = ref(localStorage.getItem('opslane_project_id') ?? '');
const manualId = ref('');
const showManual = ref(false);
const saved = ref(false);
const loadingProjects = ref(true);

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
  try {
    projects.value = await listProjects();
    // Load GitHub App status + per-project config
    loadGitHubAppStatus();
    if (selectedProjectId.value) {
      loadGitHubConfig(selectedProjectId.value);
    }
  } catch {
    showManual.value = true;
  } finally {
    loadingProjects.value = false;
  }
});

function save(): void {
  const id = showManual.value ? manualId.value.trim() : selectedProjectId.value;
  if (!id) return;

  localStorage.setItem('opslane_project_id', id);

  const project = projects.value.find((p) => p.id === id);
  if (project) {
    localStorage.setItem('opslane_project_name', project.name);
  } else {
    localStorage.removeItem('opslane_project_name');
  }

  saved.value = true;
  setTimeout(() => { saved.value = false; }, 2000);

  // Reload GitHub config for newly selected project
  loadGitHubConfig(id);
}

function switchTab(tab: 'project' | 'environments' | 'api-keys'): void {
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
    environments.value = await listEnvironments(pid);
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
    <div class="border-b border-border mb-6">
      <nav class="-mb-px flex gap-6">
        <button
          class="py-2 px-1 text-sm font-medium border-b-2 transition-colors"
          :class="activeTab === 'project' ? 'tab-active' : 'tab-inactive'"
          @click="switchTab('project')"
        >
          Project
        </button>
        <button
          class="py-2 px-1 text-sm font-medium border-b-2 transition-colors"
          :class="activeTab === 'environments' ? 'tab-active' : 'tab-inactive'"
          @click="switchTab('environments')"
        >
          Environments
        </button>
        <button
          class="py-2 px-1 text-sm font-medium border-b-2 transition-colors"
          :class="activeTab === 'api-keys' ? 'tab-active' : 'tab-inactive'"
          @click="switchTab('api-keys')"
        >
          API Keys
        </button>
      </nav>
    </div>

    <!-- Project tab -->
    <div v-if="activeTab === 'project'" class="max-w-lg">
      <p class="text-sm text-text-muted mb-6">
        Configure your active project. This determines which project's incidents you
        see in the activity feed.
      </p>

      <div v-if="loadingProjects" class="text-sm text-text-muted">Loading projects...</div>

      <form v-else @submit.prevent="save" class="space-y-4">
        <div v-if="!showManual">
          <label for="settings-project-select" class="block text-sm font-medium text-text-muted">
            Project
          </label>
          <select
            id="settings-project-select"
            v-model="selectedProjectId"
            class="mt-1 block w-full rounded-md px-3 py-2 text-sm"
          >
            <option value="" disabled>Select a project</option>
            <option
              v-for="project in projects"
              :key="project.id"
              :value="project.id"
              v-text="project.name"
            ></option>
          </select>
          <button
            type="button"
            @click="showManual = true"
            class="mt-2 text-xs text-text-muted hover:text-text underline"
          >
            Enter project ID manually
          </button>
        </div>

        <div v-else>
          <label for="manual-project-id" class="block text-sm font-medium text-text-muted">
            Project ID
          </label>
          <input
            id="manual-project-id"
            v-model="manualId"
            type="text"
            placeholder="e.g. 550e8400-e29b-41d4-a716-446655440000"
            class="mt-1 block w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text focus:border-teal focus:ring-1 focus:ring-teal"
          />
          <button
            v-if="projects.length > 0"
            type="button"
            @click="showManual = false"
            class="mt-2 text-xs text-text-muted hover:text-text underline"
          >
            Select from projects list
          </button>
        </div>

        <div class="flex items-center gap-3">
          <button type="submit" class="btn-primary">
            Save
          </button>
          <span v-if="saved" class="text-sm text-green">Saved.</span>
        </div>
      </form>

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
            <span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-green-500/10 text-green">
              GitHub App installed
            </span>
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
              class="rounded-md bg-red-500/10 px-3 py-1.5 text-sm font-medium text-red hover:bg-red-500/20 focus:outline-none focus:ring-2 focus:ring-red focus:ring-offset-2 focus:ring-offset-background disabled:opacity-50"
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
                      ? 'bg-red-500/10 text-red'
                      : 'bg-green-500/10 text-green'"
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
          <div class="mt-3 rounded-md bg-amber-500/10 border border-amber-500/20 p-3">
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
