<script setup lang="ts">
import { ref } from 'vue';
import type { User } from '../types';

const props = defineProps<{ user: User }>();
const likes = ref(0);

function likeUser() {
  likes.value++;
}

function editProfile() {
  // BUG: user.profile is null, destructuring throws TypeError
  const { name, email } = props.user.profile!;
  console.log('Editing', name, email);
}
</script>

<template>
  <div class="user-card" data-testid="user-card">
    <h2>{{ user.username }}</h2>
    <p>Likes: {{ likes }}</p>
    <button data-testid="like-btn" @click="likeUser">Like</button>
    <button data-testid="edit-profile-btn" @click="editProfile">Edit Profile</button>
  </div>
</template>
