<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getMe, clearAuth, isAuthenticated, listProjects, type AuthUser, type Project } from './api';

const route = useRoute();
const router = useRouter();
const user = ref<AuthUser | null>(null);
const projectName = ref(localStorage.getItem('opslane_project_name') ?? '');

// Routes that hide the header and use full-page layout
const fullPageRoutes = ['login', 'register', 'setup', 'auth-callback'];
const isFullPage = computed(() => fullPageRoutes.includes(route.name as string));

function navLinkClass(routeName: string): string {
  const isActive = route.name === routeName;
  return isActive
    ? 'text-sm text-teal border-b-2 border-teal pb-[14px]'
    : 'text-sm text-text-muted hover:text-text pb-[14px] border-b-2 border-transparent';
}

// Project selection prompt state
const showProjectPrompt = ref(false);
const promptProjects = ref<Project[]>([]);
const promptSelectedId = ref('');

async function loadUser(): Promise<void> {
  if (!isAuthenticated()) return;
  try {
    user.value = await getMe();
  } catch {
    user.value = null;
  }
}

async function checkProject(): Promise<void> {
  if (!isAuthenticated()) return;
  if (fullPageRoutes.includes(route.name as string)) return;

  const pid = localStorage.getItem('opslane_project_id');
  if (pid) {
    projectName.value = localStorage.getItem('opslane_project_name') ?? '';
    return;
  }

  // No project selected -- fetch and decide
  try {
    const projects = await listProjects();
    if (projects.length === 0) {
      router.push('/setup');
    } else if (projects.length === 1) {
      localStorage.setItem('opslane_project_id', projects[0].id);
      localStorage.setItem('opslane_project_name', projects[0].name);
      projectName.value = projects[0].name;
    } else {
      promptProjects.value = projects;
      promptSelectedId.value = projects[0].id;
      showProjectPrompt.value = true;
    }
  } catch {
    // Silently ignore -- project listing failed, user can set via Settings
  }
}

function selectProject(): void {
  const project = promptProjects.value.find((p) => p.id === promptSelectedId.value);
  if (!project) return;
  localStorage.setItem('opslane_project_id', project.id);
  localStorage.setItem('opslane_project_name', project.name);
  projectName.value = project.name;
  showProjectPrompt.value = false;
}

async function logout(): Promise<void> {
  await fetch('/api/v1/auth/logout', {
    method: 'POST',
    credentials: 'include',
  }).catch(() => {}); // best-effort server-side revocation
  clearAuth();
  localStorage.removeItem('opslane_project_id');
  localStorage.removeItem('opslane_project_name');
  user.value = null;
  projectName.value = '';
  router.push('/login');
}

onMounted(() => {
  loadUser();
  checkProject();
});

// After login redirect, user ref is still null -- fetch it on route change
watch(
  () => route.name,
  () => {
    if (isAuthenticated() && !user.value) {
      loadUser();
    }
    // Refresh project name from localStorage in case Login.vue just set it
    projectName.value = localStorage.getItem('opslane_project_name') ?? '';
  }
);
</script>

<template>
  <div class="min-h-screen bg-background font-sans text-text">
    <header
      v-if="!isFullPage"
      class="bg-surface border-b border-border px-6 flex items-center justify-between"
    >
      <div class="flex items-center gap-3 h-14">
        <router-link to="/" class="text-base font-semibold text-text hover:text-teal transition-colors duration-150">
          Opslane
        </router-link>
        <span
          v-if="projectName"
          class="text-sm text-text-muted border-l border-border pl-3"
          v-text="projectName"
        ></span>
      </div>
      <nav class="flex items-center gap-6 h-14">
        <router-link to="/" :class="navLinkClass('activity')">
          Incidents
        </router-link>
        <router-link to="/accounts" :class="navLinkClass('accounts')">
          Accounts
        </router-link>
        <router-link to="/settings" :class="navLinkClass('settings')">
          Settings
        </router-link>
        <span class="w-px h-5 bg-border"></span>
        <span v-if="user" class="text-sm text-text-muted" v-text="user.email"></span>
        <button
          v-if="user"
          @click="logout"
          class="text-sm text-text-muted hover:text-text transition-colors duration-150"
        >
          Sign out
        </button>
      </nav>
    </header>

    <!-- Project selection prompt -->
    <div
      v-if="showProjectPrompt && !isFullPage"
      class="max-w-lg mx-auto mt-12 bg-surface rounded-md border border-border p-8"
    >
      <h2 class="text-base font-medium text-text mb-2">Select a project</h2>
      <p class="text-sm text-text-muted mb-4">
        Choose which project to view.
      </p>
      <div class="space-y-4">
        <div>
          <label for="app-project-select" class="block text-sm font-medium text-text-muted">
            Project
          </label>
          <select
            id="app-project-select"
            v-model="promptSelectedId"
            class="mt-1 block w-full rounded-md px-3 py-2 text-sm"
          >
            <option
              v-for="project in promptProjects"
              :key="project.id"
              :value="project.id"
              v-text="project.name"
            ></option>
          </select>
        </div>
        <button
          @click="selectProject"
          class="btn-primary"
        >
          Continue
        </button>
      </div>
    </div>

    <main
      v-if="!showProjectPrompt"
      :class="!isFullPage ? 'max-w-7xl mx-auto px-6 py-8' : ''"
    >
      <router-view :key="$route.fullPath" />
    </main>
  </div>
</template>
