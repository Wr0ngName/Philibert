<script setup lang="ts">
/**
 * Settings → Tools: the tools every project has — the claude.ai connectors
 * and the user's own servers — each on, or off everywhere.
 *
 * Off everywhere is Claude Code's own user setting (`deniedMcpServers`), so
 * it applies to Claude Code in a terminal too, and wins over any project: a
 * project can turn a tool off for itself (Settings → Project), never on when
 * it is off here. Changes reach the discussions started after them; running
 * ones keep what they started with (measured on CLI 2.1.280).
 */

import { onMounted } from 'vue';

import { useMcpStore } from '../../stores/mcp';
import ClaudeAiConnectors from './ClaudeAiConnectors.vue';
import McpServersPanel from './McpServersPanel.vue';

const mcpStore = useMcpStore();

onMounted(() => {
  void mcpStore.checkGlobalTools();
});
</script>

<template>
  <div class="global-tools space-y-6">
    <p class="text-xs text-surface-500 dark:text-surface-400">
      The tools here are available in every project. Turning one off everywhere also applies to Claude Code
      in a terminal, which then says it is blocked by policy, and to discussions started from then on.
      A project can turn a tool off for itself in Project settings.
    </p>
    <ClaudeAiConnectors />
    <McpServersPanel scope="user" />
  </div>
</template>
