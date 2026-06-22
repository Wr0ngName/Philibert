/**
 * Preload script - exposes secure API to renderer via contextBridge
 */

import { contextBridge, ipcRenderer } from 'electron';

import type { ElectronAPI } from '../shared/preload-api';
import { IPC_CHANNELS, ActionResponse, type AskUserQuestionResponse, type SessionPermissionEntry, type ToolCaptureData, type ToolResultData } from '../shared/types';

// Create the API object that will be exposed to the renderer
const electronAPI: ElectronAPI = {
  // Claude operations - all operations now include conversationId for multi-instance support
  claude: {
    send: (conversationId: string, message: string, workingDir: string, resumeSessionId?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_SEND, conversationId, message, workingDir, resumeSessionId),

    approve: (
      conversationId: string,
      actionId: string,
      updatedInput?: Record<string, unknown>,
      alwaysAllow?: boolean,
      chosenScope?: string
    ) => ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_APPROVE, conversationId, actionId, updatedInput, alwaysAllow, chosenScope),

    reject: (conversationId: string, actionId: string, message?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_REJECT, conversationId, actionId, message),

    answerQuestion: (response: AskUserQuestionResponse) =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_USER_QUESTION_ANSWER, response),

    respondToAction: (response: ActionResponse) =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_ACTION_RESPONSE, response),

    abort: (conversationId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_ABORT, conversationId),

    stopTask: (conversationId: string, taskId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_STOP_TASK, conversationId, taskId),

    getCommands: () => ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_GET_COMMANDS),

    getModels: () => ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_GET_MODELS),

    getActiveQueries: () => ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_GET_ACTIVE_QUERIES),

    // Event listeners now receive conversationId as first parameter
    onChunk: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, conversationId: string, chunk: string) =>
        callback(conversationId, chunk);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_CHUNK, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_CHUNK, handler);
    },

    onToolUse: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        conversationId: string,
        action: Parameters<typeof callback>[1]
      ) => callback(conversationId, action);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_TOOL_USE, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_TOOL_USE, handler);
    },

    onError: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, conversationId: string, error: string) =>
        callback(conversationId, error);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_ERROR, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_ERROR, handler);
    },

    onDone: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, conversationId: string) =>
        callback(conversationId);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_DONE, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_DONE, handler);
    },

    onSlashCommands: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        conversationId: string,
        commands: Parameters<typeof callback>[1]
      ) => callback(conversationId, commands);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_SLASH_COMMANDS, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_SLASH_COMMANDS, handler);
    },

    onCommandAction: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        conversationId: string,
        action: Parameters<typeof callback>[1]
      ) => callback(conversationId, action);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_COMMAND_ACTION, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_COMMAND_ACTION, handler);
    },

    onModelsChanged: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        models: Parameters<typeof callback>[0]
      ) => callback(models);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_MODEL_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_MODEL_CHANGED, handler);
    },

    onTaskNotification: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        conversationId: string,
        notification: Parameters<typeof callback>[1]
      ) => callback(conversationId, notification);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_TASK_NOTIFICATION, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_TASK_NOTIFICATION, handler);
    },

    onUsageUpdate: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        conversationId: string,
        usage: Parameters<typeof callback>[1]
      ) => callback(conversationId, usage);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_USAGE_UPDATE, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_USAGE_UPDATE, handler);
    },

    onActiveQueriesChange: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        count: number,
        maxCount: number,
        processingCount: number
      ) => callback(count, maxCount, processingCount);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_ACTIVE_QUERIES, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_ACTIVE_QUERIES, handler);
    },

    onSystemNote: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        conversationId: string,
        note: string
      ) => callback(conversationId, note);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_SYSTEM_NOTE, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_SYSTEM_NOTE, handler);
    },

    onSessionId: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        conversationId: string,
        sessionId: string
      ) => callback(conversationId, sessionId);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_SESSION_ID, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_SESSION_ID, handler);
    },

    getSessionPermissions: (conversationId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_GET_SESSION_PERMISSIONS, conversationId),

    revokeSessionPermission: (conversationId: string, permissionId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_REVOKE_SESSION_PERMISSION, conversationId, permissionId),

    clearSessionPermissions: (conversationId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_CLEAR_SESSION_PERMISSIONS, conversationId),

    onSessionPermissionsChanged: (callback: (conversationId: string, permissions: SessionPermissionEntry[]) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        conversationId: string,
        permissions: SessionPermissionEntry[]
      ) => callback(conversationId, permissions);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_SESSION_PERMISSIONS_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_SESSION_PERMISSIONS_CHANGED, handler);
    },

    onToolExecuted: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        conversationId: string,
        actionId: string
      ) => callback(conversationId, actionId);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_TOOL_EXECUTED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_TOOL_EXECUTED, handler);
    },

    onToolCapture: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        conversationId: string,
        capture: ToolCaptureData
      ) => callback(conversationId, capture);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_TOOL_CAPTURE, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_TOOL_CAPTURE, handler);
    },

    onToolResult: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        conversationId: string,
        result: ToolResultData
      ) => callback(conversationId, result);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_TOOL_RESULT, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_TOOL_RESULT, handler);
    },
  },

  // Git operations
  git: {
    status: (workingDir: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_STATUS, workingDir),

    commit: (workingDir: string, message: string, stageAll: boolean, expectedBranch?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_COMMIT, workingDir, message, stageAll, expectedBranch),

    pull: (workingDir: string, expectedBranch?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_PULL, workingDir, expectedBranch),

    push: (workingDir: string, expectedBranch?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_PUSH, workingDir, expectedBranch),

    fetch: (workingDir: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_FETCH, workingDir),

    listBranches: (workingDir: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_LIST_BRANCHES, workingDir),

    checkout: (workingDir: string, branchName: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_CHECKOUT, workingDir, branchName),

    createBranch: (workingDir: string, branchName: string, checkout: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_CREATE_BRANCH, workingDir, branchName, checkout),

    getIdentity: (workingDir: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_GET_IDENTITY, workingDir),

    setIdentity: (workingDir: string, name: string, email: string, scope: 'local' | 'global') =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_SET_IDENTITY, workingDir, name, email, scope),

    onStatusChanged: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        status: Parameters<typeof callback>[0]
      ) => callback(status);
      ipcRenderer.on(IPC_CHANNELS.GIT_STATUS_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.GIT_STATUS_CHANGED, handler);
    },
  },

  // File operations
  files: {
    selectDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.FILES_SELECT_DIR),

    getTree: (directory: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.FILES_GET_TREE, directory),

    read: (filePath: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.FILES_READ, filePath),

    open: (filePath: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.FILES_OPEN, filePath),

    onChange: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        changes: Parameters<typeof callback>[0]
      ) => callback(changes);
      ipcRenderer.on(IPC_CHANNELS.FILES_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.FILES_CHANGED, handler);
    },
  },

  // Config operations
  config: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_GET),

    set: (config) => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_SET, config),

    onChange: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        config: Parameters<typeof callback>[0]
      ) => callback(config);
      ipcRenderer.on(IPC_CHANNELS.CONFIG_CHANGED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.CONFIG_CHANGED, handler);
    },
  },

  // Auth operations
  auth: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_GET_STATUS),

    startOAuth: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_START_OAUTH),

    completeOAuth: (code: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.AUTH_COMPLETE_OAUTH, code),

    logout: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_LOGOUT),

    onInvalidated: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(IPC_CHANNELS.AUTH_INVALIDATED, handler);
      return () => { ipcRenderer.removeListener(IPC_CHANNELS.AUTH_INVALIDATED, handler); };
    },
  },

  // Conversation operations
  conversation: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_LIST),

    get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_GET, id),

    save: (conversation) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_SAVE, conversation),

    rename: (id: string, newTitle: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_RENAME, id, newTitle),

    delete: (id: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_DELETE, id),

    search: (query: string, scope: 'current' | 'all', currentConversationId: string | null) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_SEARCH, query, scope, currentConversationId),
  },

  // Update operations
  update: {
    check: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CHECK),

    download: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_DOWNLOAD),

    install: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_INSTALL),

    onAvailable: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        info: Parameters<typeof callback>[0]
      ) => callback(info);
      ipcRenderer.on(IPC_CHANNELS.UPDATE_AVAILABLE, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_AVAILABLE, handler);
    },

    onProgress: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        progress: Parameters<typeof callback>[0]
      ) => callback(progress);
      ipcRenderer.on(IPC_CHANNELS.UPDATE_PROGRESS, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_PROGRESS, handler);
    },

    onDownloaded: (callback) => {
      const handler = () => callback();
      ipcRenderer.on(IPC_CHANNELS.UPDATE_DOWNLOADED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_DOWNLOADED, handler);
    },
  },

  // Window operations
  window: {
    minimize: () => ipcRenderer.send(IPC_CHANNELS.WINDOW_MINIMIZE),

    maximize: () => ipcRenderer.send(IPC_CHANNELS.WINDOW_MAXIMIZE),

    close: () => ipcRenderer.send(IPC_CHANNELS.WINDOW_CLOSE),
  },

  // Platform info
  platform: process.platform,
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('electron', electronAPI);
