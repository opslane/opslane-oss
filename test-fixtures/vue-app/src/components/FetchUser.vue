<script setup lang="ts">
import { ref } from 'vue';

const userId = ref('');
const userName = ref<string | null>(null);
const loading = ref(false);

async function loadUser() {
  loading.value = true;
  // BUG: fetches a non-existent API endpoint, response.json() throws
  // SyntaxError because the response body is HTML (404 page), not JSON
  const response = await fetch(`/api/users/${userId.value || '999'}`);
  const data = await response.json();
  userName.value = data.name;
  loading.value = false;
}
</script>

<template>
  <div data-testid="fetch-user">
    <input
      v-model="userId"
      data-testid="user-id-input"
      placeholder="Enter user ID"
    />
    <button data-testid="load-user-btn" @click="loadUser">Load User</button>
    <p v-if="loading">Loading...</p>
    <p v-else-if="userName" data-testid="fetched-name">{{ userName }}</p>
  </div>
</template>
