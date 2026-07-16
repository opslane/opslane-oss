<script setup lang="ts">
import { ref } from 'vue';
import UserCard from './components/UserCard.vue';
import AsyncLoader from './components/AsyncLoader.vue';
import WatcherBug from './components/WatcherBug.vue';
import FetchUser from './components/FetchUser.vue';
import FrictionLab from './components/FrictionLab.vue';
import type { User } from './types';

const currentView = ref<string>('home');
const buggyUser: User = { id: 1, username: 'alice', profile: null };
</script>

<template>
  <div>
    <nav>
      <button data-testid="nav-home" @click="currentView = 'home'">Home</button>
      <button data-testid="nav-usercard" @click="currentView = 'usercard'">UserCard</button>
      <button data-testid="nav-async" @click="currentView = 'async'">AsyncLoader</button>
      <button data-testid="nav-watcher" @click="currentView = 'watcher'">WatcherBug</button>
      <button data-testid="nav-fetch" @click="currentView = 'fetch'">FetchUser</button>
      <button data-testid="nav-friction" @click="currentView = 'friction'">FrictionLab</button>
    </nav>
    <main>
      <p v-if="currentView === 'home'">Select a bug to trigger</p>
      <UserCard v-if="currentView === 'usercard'" :user="buggyUser" />
      <AsyncLoader v-if="currentView === 'async'" />
      <WatcherBug v-if="currentView === 'watcher'" />
      <FetchUser v-if="currentView === 'fetch'" />
      <FrictionLab v-if="currentView === 'friction'" />
    </main>
  </div>
</template>
