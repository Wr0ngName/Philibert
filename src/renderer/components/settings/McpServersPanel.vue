<script setup lang="ts">
/**
 * Manage the tool servers (MCP servers) declared by the active project.
 *
 * Writes `<project>/.mcp.json` and the matching approval in
 * `<project>/.claude/settings.local.json` as one operation — see
 * McpConfigService and docs/mcp-servers.md for why both files are required.
 *
 * The wording here deliberately avoids "MCP", "stdio" and "transport" in the
 * places a first-time user reads first; the technical names appear only where
 * they help someone follow a third-party server's own README.
 */

import { ref, computed, watch, onMounted } from 'vue';
import { storeToRefs } from 'pinia';

import type { McpCommandCheck, McpServerEntry, McpTransport } from '@shared/types';

import { useMcpStore } from '../../stores/mcp';
import Button from '../shared/Button.vue';
import Icon from '../shared/Icon.vue';

/** One editable environment variable or header row. */
interface Pair {
  key: string;
  value: string;
}

const mcpStore = useMcpStore();
const { servers, runtimeInfo, isLoading, isSaving, error, hasProject } = storeToRefs(mcpStore);

const showForm = ref(false);
/** Name being edited, or null when the form is creating a new server. */
const editingName = ref<string | null>(null);
const confirmingDelete = ref<string | null>(null);

const formName = ref('');
const formTransport = ref<McpTransport>('stdio');
const formCommand = ref('');
const formArgs = ref('');
const formUrl = ref('');
const formPairs = ref<Pair[]>([]);
const commandCheck = ref<McpCommandCheck | null>(null);

const isRemote = computed(() => formTransport.value !== 'stdio');
const pairLabel = computed(() => (isRemote.value ? 'Headers' : 'Variables'));
const pairHint = computed(() =>
  isRemote.value
    ? 'Extra request headers, usually an access token. The server\'s instructions will say if it needs any.'
    : 'Settings the program reads, such as the location of a credentials file. The server\'s instructions will list them.'
);

const canSubmit = computed(() => {
  if (!formName.value.trim()) return false;
  if (isRemote.value) return formUrl.value.trim().length > 0;
  if (!formCommand.value.trim()) return false;
  // A failed check means the main process looked and the program is genuinely
  // not launchable from here, so saving would only produce a server that
  // silently contributes nothing. A null check is "not answered yet" — allow
  // it, since the service validates again on save.
  return commandCheck.value === null || commandCheck.value.ok;
});

onMounted(() => {
  void mcpStore.load();
});

// Re-read when the user switches project while Settings is open.
watch(hasProject, () => {
  void mcpStore.load();
});

// Validate the program path as it is typed, so a bad path is caught before
// saving rather than surfacing later as "Claude ignored my server".
watch(formCommand, async (value) => {
  if (isRemote.value) {
    commandCheck.value = null;
    return;
  }
  commandCheck.value = await mcpStore.checkCommand(value);
});

watch(formTransport, () => {
  commandCheck.value = null;
});

function resetForm(): void {
  formName.value = '';
  formTransport.value = 'stdio';
  formCommand.value = '';
  formArgs.value = '';
  formUrl.value = '';
  formPairs.value = [];
  commandCheck.value = null;
  mcpStore.clearError();
}

function startAdd(): void {
  resetForm();
  editingName.value = null;
  showForm.value = true;
}

function startEdit(server: McpServerEntry): void {
  resetForm();
  editingName.value = server.name;
  formName.value = server.name;
  formTransport.value = server.transport;
  formCommand.value = server.command ?? '';
  formArgs.value = (server.args ?? []).join('\n');
  formUrl.value = server.url ?? '';
  formPairs.value = Object.entries(
    (server.transport === 'stdio' ? server.env : server.headers) ?? {}
  ).map(([key, value]) => ({ key, value }));
  showForm.value = true;
}

function cancelForm(): void {
  showForm.value = false;
  resetForm();
}

function addPair(): void {
  formPairs.value.push({ key: '', value: '' });
}

function removePair(index: number): void {
  formPairs.value.splice(index, 1);
}

async function browseForProgram(): Promise<void> {
  const picked = await mcpStore.pickExecutable();
  if (picked) formCommand.value = picked;
}

async function browseForPairValue(index: number): Promise<void> {
  const picked = await mcpStore.pickFile();
  if (picked) formPairs.value[index].value = picked;
}

function useBundledNode(): void {
  if (runtimeInfo.value?.bundledNodePath) {
    formCommand.value = runtimeInfo.value.bundledNodePath;
  }
}

function collectPairs(): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const pair of formPairs.value) {
    const key = pair.key.trim();
    if (key) out[key] = pair.value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

async function submitForm(): Promise<void> {
  // The disabled Add button styles the state but does not prevent a submit
  // event — implicit submission from pressing Enter in a field still fires
  // here — so the guard lives with the behaviour, not the presentation.
  if (!canSubmit.value) return;

  const args = formArgs.value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const pairs = collectPairs();
  const ok = await mcpStore.save(editingName.value, {
    name: formName.value.trim(),
    transport: formTransport.value,
    ...(isRemote.value
      ? { url: formUrl.value.trim(), headers: pairs }
      : { command: formCommand.value.trim(), args, env: pairs }),
  });

  if (ok) {
    showForm.value = false;
    resetForm();
  }
}

async function confirmRemove(name: string): Promise<void> {
  const ok = await mcpStore.remove(name);
  if (ok) confirmingDelete.value = null;
}

function summaryOf(server: McpServerEntry): string {
  if (server.transport === 'stdio') {
    return [server.command, ...(server.args ?? [])].filter(Boolean).join(' ');
  }
  return server.url ?? '';
}
</script>

<template>
  <div>
    <div class="flex items-start justify-between gap-3 mb-2">
      <div>
        <h3 class="text-sm font-medium text-surface-700 dark:text-surface-300">
          Tool Servers
        </h3>
        <p class="text-xs text-surface-500 dark:text-surface-400 mt-0.5">
          Connect Claude to other services — search data, databases, issue trackers.
          Servers belong to the current project.
        </p>
      </div>
      <Button
        v-if="hasProject && !showForm"
        variant="secondary"
        size="sm"
        @click="startAdd"
      >
        <Icon
          name="plus"
          size="xs"
          class="mr-1"
        />
        Add server
      </Button>
    </div>

    <!-- No project selected -->
    <div
      v-if="!hasProject"
      class="p-3 rounded-lg border border-surface-300 dark:border-surface-600 text-xs text-surface-500 dark:text-surface-400"
    >
      Choose a project folder first — tool servers are set up per project.
    </div>

    <template v-else>
      <!-- Error from the last operation -->
      <div
        v-if="error"
        class="mb-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-xs text-red-800 dark:text-red-200 flex items-start gap-2"
      >
        <Icon
          name="error"
          size="xs"
          class="mt-0.5 shrink-0"
        />
        <span>{{ error }}</span>
      </div>

      <div
        v-if="isLoading"
        class="text-xs text-surface-500 dark:text-surface-400 py-2"
      >
        Loading…
      </div>

      <!-- Empty state -->
      <div
        v-else-if="servers.length === 0 && !showForm"
        class="p-3 rounded-lg border border-dashed border-surface-300 dark:border-surface-600 text-xs text-surface-500 dark:text-surface-400"
      >
        No tool servers yet. Add one to give Claude access to another service.
      </div>

      <!-- Server list -->
      <ul
        v-else-if="servers.length > 0"
        class="space-y-2 mb-3"
      >
        <li
          v-for="server in servers"
          :key="server.name"
          class="p-3 rounded-lg border border-surface-300 dark:border-surface-600"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium text-surface-800 dark:text-surface-200">
                  {{ server.name }}
                </span>
                <span
                  class="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded"
                  :class="server.enabled
                    ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
                    : 'bg-surface-200 dark:bg-surface-700 text-surface-500 dark:text-surface-400'"
                >
                  {{ server.enabled ? 'On' : 'Off' }}
                </span>
              </div>
              <p class="text-xs text-surface-500 dark:text-surface-400 mt-1 break-all">
                {{ summaryOf(server) }}
              </p>
              <p
                v-if="server.check && !server.check.ok"
                class="text-xs text-amber-700 dark:text-amber-300 mt-1 flex items-start gap-1"
              >
                <Icon
                  name="warning"
                  size="xs"
                  class="mt-0.5 shrink-0"
                />
                <span>{{ server.check.message }}</span>
              </p>
            </div>

            <div class="flex items-center gap-1 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                :disabled="isSaving"
                :title="server.enabled ? 'Turn off' : 'Turn on'"
                @click="mcpStore.setEnabled(server.name, !server.enabled)"
              >
                {{ server.enabled ? 'Turn off' : 'Turn on' }}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                title="Edit"
                @click="startEdit(server)"
              >
                <Icon
                  name="edit"
                  size="xs"
                />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                title="Remove"
                @click="confirmingDelete = server.name"
              >
                <Icon
                  name="trash"
                  size="xs"
                />
              </Button>
            </div>
          </div>

          <!-- Inline delete confirmation, so Settings keeps one modal -->
          <div
            v-if="confirmingDelete === server.name"
            class="mt-2 p-2 rounded bg-surface-100 dark:bg-surface-700/50 flex items-center justify-between gap-2"
          >
            <span class="text-xs text-surface-700 dark:text-surface-300">
              Remove “{{ server.name }}” from this project?
            </span>
            <div class="flex gap-1 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                @click="confirmingDelete = null"
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                :loading="isSaving"
                @click="confirmRemove(server.name)"
              >
                Remove
              </Button>
            </div>
          </div>
        </li>
      </ul>

      <!-- Add / edit form -->
      <form
        v-if="showForm"
        class="p-3 rounded-lg border border-primary-300 dark:border-primary-700 bg-primary-50/40 dark:bg-primary-900/10 space-y-3"
        @submit.prevent="submitForm"
      >
        <p class="text-xs font-medium text-surface-700 dark:text-surface-300">
          {{ editingName ? `Edit ${editingName}` : 'Add a tool server' }}
        </p>

        <!-- Name -->
        <div>
          <label
            for="mcp-name"
            class="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1"
          >
            Name
          </label>
          <input
            id="mcp-name"
            v-model="formName"
            type="text"
            placeholder="gsc"
            class="w-full px-2 py-1.5 text-sm rounded border border-surface-300 dark:border-surface-600 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100"
          >
          <p class="text-[11px] text-surface-500 dark:text-surface-400 mt-1">
            A short label. Claude will see this server's tools as
            <code>mcp__{{ formName.trim() || 'name' }}__…</code>
          </p>
        </div>

        <!-- Transport -->
        <div>
          <span class="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1">
            Where does it run?
          </span>
          <div class="flex gap-2">
            <button
              type="button"
              :class="[
                'flex-1 px-3 py-2 rounded-lg border text-xs font-medium text-left transition-colors',
                formTransport === 'stdio'
                  ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300'
                  : 'border-surface-300 dark:border-surface-600 text-surface-600 dark:text-surface-400',
              ]"
              @click="formTransport = 'stdio'"
            >
              <span class="block font-medium">A program on this computer</span>
              <span class="block opacity-75">You downloaded a file for it</span>
            </button>
            <button
              type="button"
              :class="[
                'flex-1 px-3 py-2 rounded-lg border text-xs font-medium text-left transition-colors',
                formTransport !== 'stdio'
                  ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300'
                  : 'border-surface-300 dark:border-surface-600 text-surface-600 dark:text-surface-400',
              ]"
              @click="formTransport = 'http'"
            >
              <span class="block font-medium">A web address</span>
              <span class="block opacity-75">Hosted by someone else</span>
            </button>
          </div>
        </div>

        <!-- stdio fields -->
        <template v-if="!isRemote">
          <div>
            <label
              for="mcp-command"
              class="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1"
            >
              Program
            </label>
            <div class="flex gap-2">
              <input
                id="mcp-command"
                v-model="formCommand"
                type="text"
                placeholder="Full path to the program file"
                class="flex-1 min-w-0 px-2 py-1.5 text-sm rounded border border-surface-300 dark:border-surface-600 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100"
              >
              <Button
                variant="secondary"
                size="sm"
                @click="browseForProgram"
              >
                Browse…
              </Button>
            </div>
            <p
              v-if="commandCheck && commandCheck.ok"
              class="text-[11px] text-green-700 dark:text-green-400 mt-1 flex items-center gap-1"
            >
              <Icon
                name="check"
                size="xs"
              />
              Found — this program can be started.
            </p>
            <p
              v-else-if="commandCheck && commandCheck.message"
              class="text-[11px] text-amber-700 dark:text-amber-300 mt-1 flex items-start gap-1"
            >
              <Icon
                name="warning"
                size="xs"
                class="mt-0.5 shrink-0"
              />
              <span>{{ commandCheck.message }}</span>
            </p>
            <p
              v-if="runtimeInfo?.bundledNodePath"
              class="text-[11px] text-surface-500 dark:text-surface-400 mt-1"
            >
              Running a <code>.js</code> server?
              <button
                type="button"
                class="underline hover:text-primary-600 dark:hover:text-primary-400"
                @click="useBundledNode"
              >
                Use the Node included with Philibert
              </button>
              and put the script path in Arguments.
            </p>
          </div>

          <div>
            <label
              for="mcp-args"
              class="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1"
            >
              Arguments <span class="font-normal opacity-75">(optional, one per line)</span>
            </label>
            <textarea
              id="mcp-args"
              v-model="formArgs"
              rows="2"
              placeholder="--port&#10;8080"
              class="w-full px-2 py-1.5 text-sm font-mono rounded border border-surface-300 dark:border-surface-600 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100"
            />
          </div>
        </template>

        <!-- remote fields -->
        <template v-else>
          <div>
            <label
              for="mcp-url"
              class="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1"
            >
              Web address
            </label>
            <input
              id="mcp-url"
              v-model="formUrl"
              type="text"
              placeholder="https://example.com/mcp"
              class="w-full px-2 py-1.5 text-sm rounded border border-surface-300 dark:border-surface-600 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100"
            >
          </div>
        </template>

        <!-- env / headers -->
        <div>
          <span class="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1">
            {{ pairLabel }} <span class="font-normal opacity-75">(optional)</span>
          </span>
          <div
            v-for="(pair, index) in formPairs"
            :key="index"
            class="flex gap-2 mb-1"
          >
            <input
              v-model="pair.key"
              type="text"
              placeholder="NAME"
              aria-label="Name"
              class="w-2/5 min-w-0 px-2 py-1.5 text-sm font-mono rounded border border-surface-300 dark:border-surface-600 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100"
            >
            <input
              v-model="pair.value"
              type="text"
              placeholder="value"
              aria-label="Value"
              class="flex-1 min-w-0 px-2 py-1.5 text-sm font-mono rounded border border-surface-300 dark:border-surface-600 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100"
            >
            <Button
              v-if="!isRemote"
              variant="ghost"
              size="sm"
              title="Pick a file for this value"
              @click="browseForPairValue(index)"
            >
              <Icon
                name="folder"
                size="xs"
              />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              title="Remove"
              @click="removePair(index)"
            >
              <Icon
                name="minus"
                size="xs"
              />
            </Button>
          </div>
          <button
            type="button"
            class="text-[11px] text-primary-600 dark:text-primary-400 hover:underline"
            @click="addPair"
          >
            + Add {{ isRemote ? 'a header' : 'a variable' }}
          </button>
          <p class="text-[11px] text-surface-500 dark:text-surface-400 mt-1">
            {{ pairHint }}
          </p>
        </div>

        <div class="flex justify-end gap-2 pt-1">
          <Button
            variant="ghost"
            size="sm"
            @click="cancelForm"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            :disabled="!canSubmit"
            :loading="isSaving"
          >
            {{ editingName ? 'Save' : 'Add' }}
          </Button>
        </div>
      </form>

      <p
        v-if="servers.length > 0 || showForm"
        class="text-[11px] text-surface-500 dark:text-surface-400 mt-2"
      >
        Changes apply to new conversations — existing ones keep the servers they
        started with.
      </p>
    </template>
  </div>
</template>
