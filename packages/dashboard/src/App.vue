<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getMe, clearAuth, isAuthenticated, listProjects, type AuthUser, type Project } from './api';
import { routeNeedsProject } from './route-project';
import OrgSwitcher from './components/OrgSwitcher.vue';
import ProjectSwitcher from './components/ProjectSwitcher.vue';
import { getProjectId } from './utils';

const route = useRoute();
const router = useRouter();
const user = ref<AuthUser | null>(null);
const projectName = ref(localStorage.getItem('opslane_project_name') ?? '');
const projects = ref<Project[]>([]);
const activeProjectId = ref(getProjectId());

// Routes that hide the header and use full-page layout
const fullPageRoutes = ['login', 'register', 'setup', 'auth-complete', 'invite-accept', 'reset-password'];
const isFullPage = computed(() => fullPageRoutes.includes(route.name as string));

function navLinkClass(routeName: string): string {
  const detailRoutes: Record<string, string[]> = {
    accounts: ['account-detail'],
    sessions: ['session-detail'],
  };
  const isActive = route.name === routeName || (detailRoutes[routeName]?.includes(route.name as string) ?? false);
  return isActive
    ? 'rounded-lg bg-teal/10 px-3 py-1.5 text-sm font-medium text-teal'
    : 'rounded-lg px-3 py-1.5 text-sm text-text-muted hover:text-text hover:bg-surface-2';
}

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
  try {
    projects.value = await listProjects();
    if (projects.value.length === 0) {
      if (routeNeedsProject(route.name)) await router.push('/setup');
      return;
    }
    const effectiveID = getProjectId();
    const active = projects.value.find((project) => project.id === effectiveID) ?? projects.value[0];
    if (!effectiveID || active.id !== effectiveID) {
      localStorage.setItem('opslane_project_id', active.id);
    }
    localStorage.setItem('opslane_project_name', active.name);
    activeProjectId.value = active.id;
    projectName.value = active.name;
  } catch {
    // Silently ignore -- project listing failed, user can set via Settings
  }
}

function onProjectChange(project: Project): void {
  activeProjectId.value = project.id;
  projectName.value = project.name;
}

function onProjectsChanged(): void {
  void checkProject();
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
  projects.value = [];
  activeProjectId.value = '';
  projectName.value = '';
  router.push('/login');
}

onMounted(() => {
  void loadUser();
  void checkProject();
  window.addEventListener('opslane-projects-changed', onProjectsChanged);
});

onUnmounted(() => {
  window.removeEventListener('opslane-projects-changed', onProjectsChanged);
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
    activeProjectId.value = getProjectId();
    if (isAuthenticated() && projects.value.length === 0) void checkProject();
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
        <OrgSwitcher
          v-if="user?.memberships?.length"
          :memberships="user.memberships"
          :active-org-id="user.active_org_id ?? user.org_id"
        />
        <ProjectSwitcher
          :projects="projects"
          :active-project-id="activeProjectId"
          @project-change="onProjectChange"
        />
      </div>
      <nav class="flex items-center gap-2 h-14">
        <router-link to="/" :class="navLinkClass('activity')">
          Incidents
        </router-link>
        <router-link to="/accounts" :class="navLinkClass('accounts')">
          Accounts
        </router-link>
        <router-link to="/sessions" :class="navLinkClass('sessions')">
          Sessions
        </router-link>
        <router-link to="/settings" :class="navLinkClass('settings')">
          Settings
        </router-link>
        <router-link v-if="user?.is_admin" to="/admin" :class="navLinkClass('admin')">
          Admin
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

    <main
      :class="!isFullPage ? 'max-w-7xl mx-auto px-6 py-8' : ''"
    >
      <router-view :key="`${activeProjectId}:${$route.fullPath}`" />
    </main>
  </div>
</template>
