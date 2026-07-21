<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { createInvitation, listInvitations, revokeInvitation } from '../api';
import type { AuthMembership, OrgInvitation } from '../types/api';
import { canManageInvitations } from './invitation-permissions';
import Button from './ui/Button.vue';

const props = defineProps<{ activeRole?: AuthMembership['role'] }>();
const canManage = computed(() => canManageInvitations(props.activeRole));
const invitations = ref<OrgInvitation[]>([]);
const email = ref('');
const role = ref<AuthMembership['role']>('member');
const loading = ref(false);
const error = ref('');
const inviteURL = ref('');

async function load(): Promise<void> {
  if (!canManage.value) return;
  loading.value = true;
  error.value = '';
  try {
    invitations.value = await listInvitations();
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Unable to load invitations';
  } finally {
    loading.value = false;
  }
}

async function submit(): Promise<void> {
  if (!email.value.trim()) return;
  loading.value = true;
  error.value = '';
  inviteURL.value = '';
  try {
    const created = await createInvitation(email.value.trim(), role.value);
    invitations.value.unshift(created.invitation);
    inviteURL.value = `${window.location.origin}/invite/accept?token=${encodeURIComponent(created.token)}`;
    email.value = '';
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Unable to create invitation';
  } finally {
    loading.value = false;
  }
}

async function revoke(invitationID: string): Promise<void> {
  error.value = '';
  try {
    await revokeInvitation(invitationID);
    invitations.value = invitations.value.map((invitation) =>
      invitation.id === invitationID
        ? { ...invitation, revoked_at: new Date().toISOString() }
        : invitation,
    );
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Unable to revoke invitation';
  }
}

onMounted(load);
</script>

<template>
  <section v-if="canManage" class="space-y-5">
    <div>
      <h3 class="text-sm font-medium text-text">Organization invitations</h3>
      <p class="mt-1 text-sm text-muted">Invite people to the active organization.</p>
    </div>
    <form class="flex flex-wrap gap-3" @submit.prevent="submit">
      <input
        v-model="email"
        type="email"
        required
        placeholder="person@example.com"
        class="min-w-64 flex-1 rounded-md border border-border bg-surface-subtle px-3 py-2 text-sm"
      />
      <select v-model="role" class="rounded-md border border-border bg-surface-subtle px-3 py-2 text-sm">
        <option value="member">Member</option>
        <option value="admin">Admin</option>
        <option value="owner">Owner</option>
      </select>
      <Button variant="primary" :disabled="loading">Invite</Button>
    </form>
    <p v-if="inviteURL" class="break-all rounded-md bg-surface-subtle p-3 text-xs text-muted">
      Invite link: <span v-text="inviteURL"></span>
    </p>
    <p v-if="error" class="text-sm text-danger" v-text="error"></p>
    <div v-if="loading && invitations.length === 0" class="text-sm text-muted">Loading…</div>
    <ul v-else class="divide-y divide-border rounded-md border border-border">
      <li v-for="invitation in invitations" :key="invitation.id" class="flex items-center justify-between gap-4 p-3">
        <div>
          <div class="text-sm text-text" v-text="invitation.email"></div>
          <div class="text-xs text-muted">
            {{ invitation.role }} ·
            {{ invitation.accepted_at ? 'accepted' : invitation.revoked_at ? 'revoked' : 'pending' }}
          </div>
        </div>
        <Button variant="danger" class="text-xs text-danger hover:underline" v-if="!invitation.accepted_at && !invitation.revoked_at" @click="revoke(invitation.id)">
          Revoke
        </Button>
      </li>
    </ul>
  </section>
  <p v-else class="text-sm text-muted">Only organization admins can manage invitations.</p>
</template>
