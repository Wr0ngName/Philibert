/**
 * Session Permission Cache
 *
 * The permissions each discussion was granted "for this session": the one
 * place they are kept, whatever session of the CLI the discussion runs in.
 * Saved with the discussion and seeded back after the app restarts.
 *
 * It decides nothing itself. The CLI matches tool calls against the rules, as
 * it does for every other rule (see ClaudeCodeService.syncSessionGrants):
 *
 * - `rule` entries are given to the CLI as allow rules in its flag-settings
 *   layer, live, so that one can be taken back while the session runs;
 * - a `mode` entry is the permission mode the session runs in;
 * - `directory` entries are the session's added working directories.
 *
 * Project/global permissions are not kept here: the CLI writes them to the
 * settings files.
 */

import type { PermissionMode, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';

import { generateId, ID_PREFIXES } from '../../../shared/id';
import { cliRuleString, entryInForce, normalizeSessionEntries, SHELL_TOOLS } from '../../../shared/session-permissions';
import type { SessionPermissionEntry } from '../../../shared/types';
import logger from '../../utils/logger';

/**
 * The SDK's permission modes, checked against its type both ways: a mode it
 * adds or drops is a compile error here.
 */
const PERMISSION_MODES = {
	default: true,
	acceptEdits: true,
	bypassPermissions: true,
	plan: true,
	dontAsk: true,
	auto: true,
} satisfies Record<PermissionMode, true>;

function isPermissionMode(mode: string): mode is PermissionMode {
	return Object.hasOwn(PERMISSION_MODES, mode);
}

type PermissionChangeCallback = (conversationId: string, permissions: SessionPermissionEntry[]) => void;

/** How the session ran when something was granted, and for which tool's ask. */
export interface RuleGrantOptions {
	/**
	 * The session ran sandboxed. A shell rule granted then is marked so, and
	 * so is all that is granted in answer to a shell command's ask — its mode
	 * and directories (`askingTool`): each is in force inside the sandbox only
	 * (SessionPermissionEntry.sandboxed). Other tools' rules, and what other
	 * tools' asks grant, are not marked: the sandbox confines shell commands
	 * only.
	 */
	sandboxed?: boolean;
	/** The tool whose ask the grant answers. */
	askingTool?: string;
}

/** Whether a mode or directory granted with these options is the sandbox's only. */
function sandboxOnly(options: RuleGrantOptions): boolean {
	return options.sandboxed === true && !!options.askingTool && SHELL_TOOLS.has(options.askingTool);
}

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
	 * Keep what a "for this session" answer granted: the session-scoped
	 * updates among `updates` — allow rules, a permission mode, directories.
	 * Updates for a settings file are the CLI's to write, and removals and
	 * deny rules grant nothing; none of those is kept.
	 */
	addPermissions(conversationId: string, updates: PermissionUpdate[], options: RuleGrantOptions = {}): void {
		const entries = this.cache.get(conversationId) ?? [];
		let changed = false;

		for (const update of updates) {
			if (update.destination !== 'session' && update.destination !== 'cliArg') continue;

			if ((update.type === 'addRules' || update.type === 'replaceRules') && update.behavior === 'allow') {
				for (const rule of update.rules) {
					changed = this.pushRule(conversationId, entries, rule.toolName, rule.ruleContent, options) || changed;
				}
			} else if (update.type === 'setMode') {
				changed = this.pushMode(conversationId, entries, update.mode, sandboxOnly(options)) || changed;
			} else if (update.type === 'addDirectories') {
				for (const directory of update.directories) {
					changed = this.pushDirectory(conversationId, entries, directory, sandboxOnly(options)) || changed;
				}
			}
		}

		if (!changed) return;
		this.cache.set(conversationId, entries);
		this.notifyChange(conversationId);
	}

	/**
	 * Keep one allow rule: the whole tool without `ruleContent`. Used when the
	 * CLI suggested no session rule for what was allowed for the session.
	 * Idempotent.
	 */
	addRule(conversationId: string, toolName: string, ruleContent?: string, options: RuleGrantOptions = {}): void {
		const entries = this.cache.get(conversationId) ?? [];
		if (!this.pushRule(conversationId, entries, toolName, ruleContent, options)) return;
		this.cache.set(conversationId, entries);
		this.notifyChange(conversationId);
	}

	private pushRule(
		conversationId: string,
		entries: SessionPermissionEntry[],
		toolName: string,
		ruleContent: string | undefined,
		options: RuleGrantOptions,
	): boolean {
		const content = ruleContent || undefined;
		const sandboxed = options.sandboxed === true && SHELL_TOOLS.has(toolName);
		const isDuplicate = entries.some((e) => e.kind === 'rule'
			&& e.toolName === toolName && e.ruleContent === content && (e.sandboxed === true) === sandboxed);
		if (isDuplicate) return false;

		const entry: SessionPermissionEntry = {
			id: generateId(ID_PREFIXES.ACTION),
			kind: 'rule',
			toolName,
			...(content ? { ruleContent: content } : {}),
			...(sandboxed ? { sandboxed: true } : {}),
			description: content
				? `Allow ${toolName} (${content}) for this session`
				: `Allow ${toolName} for this session`,
			grantedAt: Date.now(),
		};
		entries.push(entry);
		logger.info('Session permission cached (rule)', {
			conversationId,
			toolName,
			hasContent: content !== undefined,
			sandboxed,
			permissionId: entry.id,
		});
		return true;
	}

	/**
	 * One mode at a time: a new one replaces the one before — unless it is the
	 * same mode, already in force at least as widely (sandbox only, or not).
	 */
	private pushMode(conversationId: string, entries: SessionPermissionEntry[], mode: string, sandboxed: boolean): boolean {
		const existing = entries.findIndex((e) => e.kind === 'mode');
		if (existing !== -1) {
			const current = entries[existing];
			if (current.kind === 'mode' && current.mode === mode && (!current.sandboxed || sandboxed)) return false;
			entries.splice(existing, 1);
		}
		const entry: SessionPermissionEntry = {
			id: generateId(ID_PREFIXES.ACTION),
			kind: 'mode',
			mode,
			...(sandboxed ? { sandboxed: true } : {}),
			description: `Mode: ${mode} for this session`,
			grantedAt: Date.now(),
		};
		entries.push(entry);
		logger.info('Session permission cached (mode)', { conversationId, mode, sandboxed, permissionId: entry.id });
		return true;
	}

	/** A directory, once; given again beyond the sandbox, it replaces the grant that was the sandbox's only. */
	private pushDirectory(conversationId: string, entries: SessionPermissionEntry[], directory: string, sandboxed: boolean): boolean {
		const existing = entries.findIndex((e) => e.kind === 'directory' && e.directory === directory);
		if (existing !== -1) {
			if (!entries[existing].sandboxed || sandboxed) return false;
			entries.splice(existing, 1);
		}
		const entry: SessionPermissionEntry = {
			id: generateId(ID_PREFIXES.ACTION),
			kind: 'directory',
			directory,
			...(sandboxed ? { sandboxed: true } : {}),
			description: `Allow directory: ${directory}`,
			grantedAt: Date.now(),
		};
		entries.push(entry);
		logger.info('Session permission cached (directory)', { conversationId, directory, sandboxed, permissionId: entry.id });
		return true;
	}

	/**
	 * The allow rules in force, in the CLI's rule syntax, for a session that
	 * runs sandboxed or not (see entryInForce).
	 */
	allowRules(conversationId: string, sandboxed: boolean): string[] {
		return this.inForce(conversationId, sandboxed)
			.flatMap((e) => (e.kind === 'rule' ? [cliRuleString(e.toolName, e.ruleContent)] : []));
	}

	/**
	 * The permission mode granted for a session that runs sandboxed or not, if
	 * one was — and is one this SDK knows: a saved mode it does not is not
	 * passed on.
	 */
	mode(conversationId: string, sandboxed: boolean): PermissionMode | undefined {
		const entry = this.inForce(conversationId, sandboxed).find((e) => e.kind === 'mode');
		return entry?.kind === 'mode' && isPermissionMode(entry.mode) ? entry.mode : undefined;
	}

	/** The directories added to a session that runs sandboxed or not. */
	directories(conversationId: string, sandboxed: boolean): string[] {
		return this.inForce(conversationId, sandboxed)
			.flatMap((e) => (e.kind === 'directory' ? [e.directory] : []));
	}

	/** The grants in force for a session that runs sandboxed or not. */
	private inForce(conversationId: string, sandboxed: boolean): SessionPermissionEntry[] {
		return this.getPermissions(conversationId).filter((e) => entryInForce(e, sandboxed));
	}

	/**
	 * Revoke a specific permission by its ID.
	 * Returns the entry taken away, or null when there was none.
	 */
	revokePermission(conversationId: string, permissionId: string): SessionPermissionEntry | null {
		const entries = this.cache.get(conversationId);
		if (!entries) return null;

		const index = entries.findIndex((e) => e.id === permissionId);
		if (index === -1) return null;

		const removed = entries.splice(index, 1)[0];
		logger.info('Session permission revoked', { conversationId, permissionId, kind: removed.kind });

		if (entries.length === 0) {
			this.cache.delete(conversationId);
		}

		this.notifyChange(conversationId);
		return removed;
	}

	/**
	 * Get all permissions for a conversation.
	 * Returns empty array for unknown conversations.
	 */
	getPermissions(conversationId: string): SessionPermissionEntry[] {
		return this.cache.get(conversationId) ?? [];
	}

	/**
	 * Seed the cache for a conversation from persisted state (e.g. reloading
	 * a saved conversation after app restart), read into today's shape (see
	 * normalizeSessionEntry). No-op if entries already exist for this
	 * conversation — we don't clobber in-flight grants made in the current
	 * session with a stale on-disk snapshot.
	 *
	 * @returns whether the cache took the entries.
	 */
	seed(conversationId: string, saved: unknown): boolean {
		const entries = normalizeSessionEntries(saved);
		if (!entries.length) return false;
		const existing = this.cache.get(conversationId);
		if (existing && existing.length > 0) {
			return false;
		}
		this.cache.set(conversationId, entries);
		logger.info('Session permissions seeded from persisted state', {
			conversationId,
			count: entries.length,
			// Which grants: a prompt after a restart is answered by whether its
			// tool is among them, and the count alone could not say.
			grants: entries.map((e) => (e.kind === 'rule' ? e.toolName : e.kind)),
		});
		this.notifyChange(conversationId);
		return true;
	}

	/**
	 * Clear all permissions for a conversation.
	 * Returns the entries taken away.
	 */
	clearConversation(conversationId: string): SessionPermissionEntry[] {
		const removed = this.cache.get(conversationId) ?? [];
		if (this.cache.has(conversationId)) {
			this.cache.delete(conversationId);
			logger.info('Session permissions cleared for conversation', { conversationId });
			this.notifyChange(conversationId);
		}
		return removed;
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
