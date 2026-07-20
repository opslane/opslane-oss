<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import type { Project } from '../api';
import {
  applyProjectSelection,
  projectSwitchQuery,
  shouldSwitchProject,
} from './project-switcher';

const props = defineProps<{
  projects: Project[];
  activeProjectId: string;
}>();

const emit = defineEmits<{
  (event: 'project-change', project: Project): void;
}>();

const route = useRoute();
const router = useRouter();
const selected = ref(props.activeProjectId);
const switching = ref(false);
const error = ref('');

watch(() => props.activeProjectId, (value) => { selected.value = value; });

async function handleSwitch(): Promise<void> {
  if (!shouldSwitchProject(selected.value, props.activeProjectId, switching.value)) return;
  const project = props.projects.find((candidate) => candidate.id === selected.value);
  if (!project) {
    selected.value = props.activeProjectId;
    return;
  }

  switching.value = true;
  error.value = '';
  try {
    applyProjectSelection(localStorage, project);
    await router.push({ path: '/', query: projectSwitchQuery(route.query) });
    emit('project-change', project);
  } catch (caught: unknown) {
    selected.value = props.activeProjectId;
    error.value = caught instanceof Error ? caught.message : 'Unable to switch project';
  } finally {
    switching.value = false;
  }
}
</script>

<template>
  <div v-if="projects.length > 1" class="flex items-center gap-2">
    <label for="project-switcher" class="sr-only">Project</label>
    <select
      id="project-switcher"
      v-model="selected"
      :disabled="switching"
      class="rounded-md border border-border bg-surface-subtle px-2 py-1 text-sm text-text"
      @change="handleSwitch"
    >
      <option
        v-for="project in projects"
        :key="project.id"
        :value="project.id"
        v-text="project.name"
      ></option>
    </select>
    <span v-if="error" class="text-xs text-danger" v-text="error"></span>
  </div>
</template>
