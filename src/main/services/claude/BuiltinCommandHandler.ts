/**
 * Built-in Command Handler for Claude Code
 *
 * Handles built-in CLI commands that are NOT supported by the SDK.
 * The SDK only supports "skills" (custom commands), not the interactive CLI commands.
 * These commands must be handled locally in the app.
 */

import { SlashCommandInfo } from '../../../shared/types';
import logger from '../../utils/logger';

/**
 * Built-in CLI commands with descriptions
 * These match the actual Claude Code CLI commands shown in /help output
 * Source: https://shipyard.build/blog/claude-code-cheat-sheet/
 */
export const BUILTIN_COMMANDS: SlashCommandInfo[] = [
  // Core session commands
  { name: 'help', description: 'Show all available slash commands', argumentHint: '' },
  { name: 'clear', description: 'Clear conversation history and start fresh', argumentHint: '' },
  { name: 'compact', description: 'Compress context by summarizing conversation', argumentHint: '[focus area]' },

  // Configuration commands
  { name: 'config', description: 'Configure Claude Code settings interactively', argumentHint: '' },
  { name: 'allowed-tools', description: 'Configure tool permissions interactively', argumentHint: '' },
  { name: 'hooks', description: 'Configure hooks for automation', argumentHint: '' },
  { name: 'model', description: 'Switch AI model for current session', argumentHint: '[model name]' },
  { name: 'vim', description: 'Enable vim-style editing mode', argumentHint: '' },

  // MCP and agents
  { name: 'mcp', description: 'Manage Model Context Protocol servers', argumentHint: '' },
  { name: 'agents', description: 'Create, edit, and list subagents', argumentHint: '' },

  // Setup commands
  { name: 'terminal-setup', description: 'Install terminal shortcuts for iTerm2/VS Code', argumentHint: '' },
  { name: 'install-github-app', description: 'Set up GitHub Actions integration', argumentHint: '' },
  { name: 'doctor', description: 'Run diagnostics on your setup', argumentHint: '' },

  // Session info commands (may be passed to SDK)
  { name: 'status', description: 'View current session status', argumentHint: '' },
  { name: 'cost', description: 'Show token usage and cost information', argumentHint: '' },
  { name: 'context', description: 'View current context window usage', argumentHint: '' },

  // Memory and permissions
  { name: 'memory', description: 'Edit CLAUDE.md memory file', argumentHint: '' },
  { name: 'permissions', description: 'Manage tool permissions', argumentHint: '' },

  // Auth commands (handled by GUI settings)
  { name: 'login', description: 'Switch accounts or re-authenticate', argumentHint: '' },
  { name: 'logout', description: 'Log out of current account', argumentHint: '' },

  // Misc
  { name: 'bug', description: 'Report a bug to Anthropic', argumentHint: '' },
];

/**
 * Built-in CLI commands that must be handled locally (not by SDK)
 */
export const BUILTIN_COMMAND_NAMES = new Set(BUILTIN_COMMANDS.map(c => c.name));

/**
 * Result of handling a built-in command
 */
export interface BuiltinCommandResult {
  /** Whether the command was handled */
  handled: boolean;
  /** Response message to display */
  response?: string;
  /** Whether this command requires special action (e.g., clear conversation) */
  action?: 'clear' | 'compact' | 'login' | 'logout';
}

/**
 * Callbacks for built-in command actions
 */
export interface BuiltinCommandCallbacks {
  /** Get available slash commands for /help */
  getSlashCommands: () => SlashCommandInfo[];
  /** Emit response chunk */
  onChunk: (chunk: string) => void;
  /** Signal command completion */
  onDone: () => void;
}

/**
 * Handler for built-in CLI commands
 */
export class BuiltinCommandHandler {
  private callbacks: BuiltinCommandCallbacks;

  constructor(callbacks: BuiltinCommandCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Check if a message is a built-in command
   */
  isBuiltinCommand(message: string): boolean {
    const trimmed = message.trim();
    if (!trimmed.startsWith('/')) return false;

    const commandName = trimmed.slice(1).split(/\s+/)[0].toLowerCase();
    return BUILTIN_COMMAND_NAMES.has(commandName);
  }

  /**
   * Handle a built-in command
   * Returns the result with response and any required action
   */
  handleCommand(message: string): BuiltinCommandResult {
    const trimmed = message.trim();
    const parts = trimmed.slice(1).split(/\s+/);
    const commandName = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    logger.info('Handling built-in command', { commandName, args });

    switch (commandName) {
      // Core commands
      case 'help':
        return this.handleHelp();
      case 'clear':
        return this.handleClear();
      case 'compact':
        return this.handleCompact(args);

      // Configuration commands
      case 'config':
        return this.handleConfig();
      case 'allowed-tools':
        return this.handleAllowedTools();
      case 'hooks':
        return this.handleHooks();
      case 'model':
        return this.handleModel(args);
      case 'vim':
        return this.handleVim();

      // MCP and agents
      case 'mcp':
        return this.handleMcp();
      case 'agents':
        return this.handleAgents();

      // Setup commands
      case 'terminal-setup':
        return this.handleTerminalSetup();
      case 'install-github-app':
        return this.handleInstallGithubApp();
      case 'doctor':
        return this.handleDoctor();

      // Session info
      case 'status':
        return this.handleStatus();
      case 'cost':
        return this.handleCost();
      case 'context':
        return this.handleContext();

      // Memory and permissions
      case 'memory':
        return this.handleMemory();
      case 'permissions':
        return this.handlePermissions();

      // Auth commands
      case 'login':
        return this.handleLogin();
      case 'logout':
        return this.handleLogout();

      // Misc
      case 'bug':
        return this.handleBug();

      default:
        return { handled: false };
    }
  }

  private handleHelp(): BuiltinCommandResult {
    // Get cached commands (may include SDK skills if a query has been made)
    let commands = this.callbacks.getSlashCommands();

    // If no commands cached yet, use built-in commands
    if (commands.length === 0) {
      commands = BUILTIN_COMMANDS;
      logger.debug('Using built-in commands for /help (no cached commands)');
    }

    const lines = [
      '## Available Slash Commands\n',
      ...commands.map(cmd => {
        const hint = cmd.argumentHint ? ` ${cmd.argumentHint}` : '';
        const desc = cmd.description || 'No description available';
        return `- **/${cmd.name}**${hint} - ${desc}`;
      }),
      '\n_Note: Additional commands may be available after starting a conversation._',
    ];
    return {
      handled: true,
      response: lines.join('\n'),
    };
  }

  private handleClear(): BuiltinCommandResult {
    return {
      handled: true,
      response: '_Conversation cleared._\n\nStart a new conversation by typing a message.',
      action: 'clear',
    };
  }

  private handleCompact(args: string): BuiltinCommandResult {
    // Compact requires the SDK to summarize the conversation
    // We'll pass this through to the SDK as it may support it
    return {
      handled: true,
      response: `_Compacting conversation${args ? ` with focus on: ${args}` : ''}..._\n\n` +
        '**Note:** Compact is not fully supported in GUI mode. ' +
        'The conversation context is managed automatically.',
      action: 'compact',
    };
  }

  private handleConfig(): BuiltinCommandResult {
    return {
      handled: true,
      response: '_Configuration is managed through the Settings panel in GUI mode._\n\n' +
        'Click the **⚙️ Settings** button in the sidebar to configure Claude Code.',
    };
  }

  private handleAllowedTools(): BuiltinCommandResult {
    return {
      handled: true,
      response: '_Tool permissions are managed automatically in GUI mode._\n\n' +
        'Tools will request permission when first used during a conversation.',
    };
  }

  private handleHooks(): BuiltinCommandResult {
    return {
      handled: true,
      response: '_Hooks configuration is not yet supported in GUI mode._\n\n' +
        'You can configure hooks manually by editing the settings file at:\n' +
        '`~/.claude/settings.json`',
    };
  }

  private handleMcp(): BuiltinCommandResult {
    return {
      handled: true,
      response: '## MCP (Model Context Protocol)\n\n' +
        '_MCP server management is not yet supported in GUI mode._\n\n' +
        'You can manage MCP servers using the CLI:\n' +
        '- `claude mcp list` - View all servers\n' +
        '- `claude mcp add <name>` - Add a server\n' +
        '- `claude mcp remove <name>` - Remove a server',
    };
  }

  private handleAgents(): BuiltinCommandResult {
    return {
      handled: true,
      response: '## Agents\n\n' +
        '_Agent management is not yet supported in GUI mode._\n\n' +
        'You can create custom agents by adding files to:\n' +
        '- `.claude/agents/` - Project-specific agents\n' +
        '- `~/.claude/agents/` - Personal agents\n\n' +
        'Each agent is a directory with an `AGENT.md` file defining the agent persona.',
    };
  }

  private handleTerminalSetup(): BuiltinCommandResult {
    return {
      handled: true,
      response: '_Terminal setup is not applicable in GUI mode._\n\n' +
        'This command installs keyboard shortcuts for iTerm2 and VS Code terminal.\n' +
        'Use the CLI to run: `claude /terminal-setup`',
    };
  }

  private handleInstallGithubApp(): BuiltinCommandResult {
    return {
      handled: true,
      response: '_GitHub App installation is not yet supported in GUI mode._\n\n' +
        'Use the CLI to install the GitHub integration:\n' +
        '`claude /install-github-app`',
    };
  }

  private handleContext(): BuiltinCommandResult {
    return {
      handled: true,
      response: '_Context information is not available in GUI mode._\n\n' +
        'The conversation context is managed automatically by the SDK.',
    };
  }

  private handleCost(): BuiltinCommandResult {
    return {
      handled: true,
      response: '_Cost tracking is not available in GUI mode._\n\n' +
        'Check your usage at [console.anthropic.com](https://console.anthropic.com)',
    };
  }

  private handleMemory(): BuiltinCommandResult {
    return {
      handled: true,
      response: '_Memory (CLAUDE.md) editing is not yet supported in GUI mode._\n\n' +
        'You can manually edit CLAUDE.md files in your project directory.',
    };
  }

  private handlePermissions(): BuiltinCommandResult {
    return {
      handled: true,
      response: '_Permission management is handled automatically in GUI mode._\n\n' +
        'Tool permissions are requested when needed during the conversation.',
    };
  }

  private handleStatus(): BuiltinCommandResult {
    return {
      handled: true,
      response: '## Session Status\n\n' +
        '- **Mode:** GUI\n' +
        '- **Authentication:** Active\n' +
        '- **SDK:** Connected\n\n' +
        '_Detailed status information is not available in GUI mode._',
    };
  }

  private handleDoctor(): BuiltinCommandResult {
    return {
      handled: true,
      response: '## Diagnostics\n\n' +
        '_Running diagnostics is not available in GUI mode._\n\n' +
        'For troubleshooting, check the application logs at:\n' +
        '`~/.config/Philibert/logs/main.log`',
    };
  }

  private handleLogin(): BuiltinCommandResult {
    return {
      handled: true,
      response: '_To change accounts, use the Settings menu._\n\n' +
        'Go to **Settings > Authentication** to manage your login.',
      action: 'login',
    };
  }

  private handleLogout(): BuiltinCommandResult {
    return {
      handled: true,
      response: '_To logout, use the Settings menu._\n\n' +
        'Go to **Settings > Authentication > Logout**',
      action: 'logout',
    };
  }

  private handleBug(): BuiltinCommandResult {
    return {
      handled: true,
      response: '## Report a Bug\n\n' +
        'To report issues with Philibert:\n' +
        '- GitHub: [github.com/anthropics/claude-code/issues](https://github.com/anthropics/claude-code/issues)\n\n' +
        'Include your log file from `~/.config/Philibert/logs/main.log`',
    };
  }

  private handleModel(args: string): BuiltinCommandResult {
    if (args) {
      return {
        handled: true,
        response: `_To change the model, use the Model Selector in the header._\n\n` +
          `Requested model: **${args}**\n\n` +
          'Click the model dropdown in the top toolbar to select a different model.',
      };
    }
    return {
      handled: true,
      response: '## Model Selection\n\n' +
        '_Use the Model Selector dropdown in the header to change models._\n\n' +
        'The currently selected model is used for all new messages in this conversation.\n\n' +
        '**Available models** are loaded dynamically from the Claude Code SDK.',
    };
  }

  private handleVim(): BuiltinCommandResult {
    return {
      handled: true,
      response: '_Vim mode is not available in GUI mode._\n\n' +
        'The input field uses standard text editing.',
    };
  }
}

export default BuiltinCommandHandler;
