/**
 * Session Permission Cache
 *
 * Stores session-scoped permissions granted via "Always Allow" at the
 * ClaudeCodeService level. Persists across individual query() calls
 * within the same conversation.
 *
 * Only caches session-scoped permissions. Project/global permissions
 * are handled by the SDK via settings files.
 *
 * Handles all PermissionUpdate types from the SDK:
 * - addRules: per-tool permission rules (match by toolName)
 * - setMode: permission mode changes (acceptEdits, bypassPermissions, etc.)
 * - addDirectories: allowed directory additions
 */

import type { PermissionMode, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';

import { generateId, ID_PREFIXES } from '../../../shared/id';
import type { SessionPermissionEntry } from '../../../shared/types';
import logger from '../../utils/logger';

type PermissionChangeCallback = (conversationId: string, permissions: SessionPermissionEntry[]) => void;

/**
 * Maps SDK permission modes to the set of tool names they auto-approve.
 * Based on SDK documentation:
 * - acceptEdits: "Auto-accept file edit operations"
 * - bypassPermissions: "Bypass all permission checks"
 */
const MODE_TOOL_MAP: Record<string, string[] | '*'> = {
  acceptEdits: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
  bypassPermissions: '*',
};

export class SessionPermissionCache {
	private cache: Map<string, SessionPermissionEntry[]> = new Map();
	private onChangeCallback: PermissionChangeCallback | null = null;

	/**
	 * Register a callback for permission changes (used for IPC events to renderer)
	 */
	onPermissionsChanged(callback: PermissionChangeCallback): void {
		this.onChangeCallback = callback;
	}

	/**
	 * Add session permissions from an approved "Always Allow" action.
	 * Only caches suggestions with session/cliArg destinations.
	 * Handles addRules, setMode, and addDirectories permission types.
	 */
	addPermissions(conversationId: string, suggestions: PermissionUpdate[]): void {
		const entries = this.cache.get(conversationId) ?? [];

		for (const suggestion of suggestions) {
			// Only cache session-scoped permissions
			if (suggestion.destination !== 'session' && suggestion.destination !== 'cliArg') {
				continue;
			}

			if (suggestion.type === 'addRules' || suggestion.type === 'replaceRules') {
				this.addRuleEntries(conversationId, entries, suggestion.rules);
			} else if (suggestion.type === 'setMode') {
				this.addModeEntry(conversationId, entries, suggestion.mode);
			} else if (suggestion.type === 'addDirectories') {
				this.addDirectoryEntry(conversationId, entries, suggestion.directories);
			}
			// removeRules and removeDirectories are not cached (they revoke)
		}

		this.cache.set(conversationId, entries);
		this.notifyChange(conversationId);
	}

	/**
	 * Add entries from addRules/replaceRules suggestions
	 */
	private addRuleEntries(
		conversationId: string,
		entries: SessionPermissionEntry[],
		rules: Array<{ toolName: string; ruleContent?: string }>,
	): void {
		for (const rule of rules) {
			const isDuplicate = entries.some(
				(e) => e.toolName === rule.toolName && e.ruleContent === rule.ruleContent,
			);
			if (isDuplicate) {
				continue;
			}

			const entry: SessionPermissionEntry = {
				id: generateId(ID_PREFIXES.ACTION),
				toolName: rule.toolName,
				ruleContent: rule.ruleContent,
				description: `Allow ${rule.toolName} for this session`,
				grantedAt: Date.now(),
			};
			entries.push(entry);

			logger.info('Session permission cached (rule)', {
				conversationId,
				toolName: rule.toolName,
				permissionId: entry.id,
			});
		}
	}

	/**
	 * Add entries from setMode suggestions.
	 * Expands modes like "acceptEdits" into individual tool entries.
	 */
	private addModeEntry(
		conversationId: string,
		entries: SessionPermissionEntry[],
		mode: PermissionMode,
	): void {
		const tools = MODE_TOOL_MAP[mode];
		if (!tools) {
			// Unknown mode - store as a wildcard entry
			logger.info('Session permission cached (unknown mode)', { conversationId, mode });
			const isDuplicate = entries.some((e) => e.toolName === `mode:${mode}`);
			if (!isDuplicate) {
				entries.push({
					id: generateId(ID_PREFIXES.ACTION),
					toolName: `mode:${mode}`,
					description: `Mode: ${mode} for this session`,
					grantedAt: Date.now(),
				});
			}
			return;
		}

		if (tools === '*') {
			// bypassPermissions - add a wildcard entry
			const isDuplicate = entries.some((e) => e.toolName === '*');
			if (!isDuplicate) {
				entries.push({
					id: generateId(ID_PREFIXES.ACTION),
					toolName: '*',
					description: 'Bypass all permissions for this session',
					grantedAt: Date.now(),
				});
				logger.info('Session permission cached (bypass all)', { conversationId });
			}
			return;
		}

		// Expand mode to individual tool entries
		for (const toolName of tools) {
			const isDuplicate = entries.some((e) => e.toolName === toolName);
			if (isDuplicate) {
				continue;
			}
			const entry: SessionPermissionEntry = {
				id: generateId(ID_PREFIXES.ACTION),
				toolName,
				description: `Allow ${toolName} for this session (${mode})`,
				grantedAt: Date.now(),
			};
			entries.push(entry);

			logger.info('Session permission cached (mode expansion)', {
				conversationId,
				mode,
				toolName,
				permissionId: entry.id,
			});
		}
	}

	/**
	 * Add entries from addDirectories suggestions.
	 */
	private addDirectoryEntry(
		conversationId: string,
		entries: SessionPermissionEntry[],
		directories: string[],
	): void {
		for (const dir of directories) {
			const toolName = `dir:${dir}`;
			const isDuplicate = entries.some((e) => e.toolName === toolName);
			if (isDuplicate) {
				continue;
			}
			entries.push({
				id: generateId(ID_PREFIXES.ACTION),
				toolName,
				description: `Allow directory: ${dir}`,
				grantedAt: Date.now(),
			});
			logger.info('Session permission cached (directory)', { conversationId, dir });
		}
	}

	/**
	 * Add a direct session permission for a tool name.
	 * Used when SDK doesn't provide session-scoped suggestions but user explicitly grants permission.
	 * Idempotent: skips if an entry with the same toolName already exists.
	 */
	addDirectPermission(conversationId: string, toolName: string, ruleContent?: string): void {
		const entries = this.cache.get(conversationId) ?? [];

		const isDuplicate = entries.some(
			(e) => e.toolName === toolName && e.ruleContent === ruleContent,
		);
		if (isDuplicate) return;

		const entry: SessionPermissionEntry = {
			id: generateId(ID_PREFIXES.ACTION),
			toolName,
			ruleContent,
			description: ruleContent
				? `Allow ${toolName} (${ruleContent}) for this session`
				: `Allow ${toolName} for this session`,
			grantedAt: Date.now(),
		};
		entries.push(entry);
		this.cache.set(conversationId, entries);

		logger.info('Session permission cached (direct)', {
			conversationId,
			toolName,
			permissionId: entry.id,
		});

		this.notifyChange(conversationId);
	}

	/**
	 * Check if a tool use is covered by a cached session permission.
	 * Checks:
	 * 1. Direct toolName match (from addRules or mode expansion)
	 * 2. Wildcard '*' match (from bypassPermissions mode)
	 */
	isAllowed(conversationId: string, toolName: string, _input: Record<string, unknown>): boolean {
		const entries = this.cache.get(conversationId);
		if (!entries || entries.length === 0) {
			return false;
		}

		return entries.some((e) => e.toolName === toolName || e.toolName === '*');
	}

	/**
	 * Revoke a specific permission by its ID.
	 * Returns true if found and removed, false otherwise.
	 */
	revokePermission(conversationId: string, permissionId: string): boolean {
		const entries = this.cache.get(conversationId);
		if (!entries) {
			return false;
		}

		const index = entries.findIndex((e) => e.id === permissionId);
		if (index === -1) {
			return false;
		}

		const removed = entries.splice(index, 1)[0];
		logger.info('Session permission revoked', {
			conversationId,
			permissionId,
			toolName: removed.toolName,
		});

		if (entries.length === 0) {
			this.cache.delete(conversationId);
		}

		this.notifyChange(conversationId);
		return true;
	}

	/**
	 * Get all permissions for a conversation.
	 * Returns empty array for unknown conversations.
	 */
	getPermissions(conversationId: string): SessionPermissionEntry[] {
		return this.cache.get(conversationId) ?? [];
	}

	/**
	 * Clear all permissions for a conversation.
	 */
	clearConversation(conversationId: string): void {
		if (this.cache.has(conversationId)) {
			this.cache.delete(conversationId);
			logger.info('Session permissions cleared for conversation', { conversationId });
			this.notifyChange(conversationId);
		}
	}

	/**
	 * Clear all cached permissions (e.g., app closing).
	 */
	clearAll(): void {
		const conversationIds = Array.from(this.cache.keys());
		this.cache.clear();
		for (const conversationId of conversationIds) {
			this.notifyChange(conversationId);
		}
		logger.info('All session permissions cleared');
	}

	private notifyChange(conversationId: string): void {
		if (this.onChangeCallback) {
			this.onChangeCallback(conversationId, this.getPermissions(conversationId));
		}
	}
}

export default SessionPermissionCache;
