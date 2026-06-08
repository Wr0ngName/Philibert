/**
 * Claude Code Service Modules
 *
 * This directory contains the modularized components of the Claude Code Service:
 * - AuthValidator: Validates OAuth tokens and API keys
 * - BuiltinCommandHandler: Handles built-in slash commands
 * - ErrorHandler: Converts technical errors to user-friendly messages
 * - PermissionManager: Handles tool permission requests and user approval flow
 * - SDKMessageHandler: Processes messages from the Claude Code SDK
 * - SessionPermissionCache: Stores session-scoped permissions
 */

export { AuthValidator } from './AuthValidator';
export { BuiltinCommandHandler } from './BuiltinCommandHandler';
export { ErrorHandler } from './ErrorHandler';
export { PermissionManager, ASK_USER_QUESTION_TOOL, ASK_USER_QUESTION_PREFIX } from './PermissionManager';
export { SDKMessageHandler } from './SDKMessageHandler';
export { SessionPermissionCache } from './SessionPermissionCache';
