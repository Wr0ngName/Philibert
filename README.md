# Philibert

A user-friendly desktop application that brings the power of Claude Code to non-technical users.

## Overview

Philibert wraps the official [@anthropic-ai/claude-code](https://www.npmjs.com/package/@anthropic-ai/claude-code) CLI in a clean, intuitive graphical interface. No terminal required, no Node.js installation needed - just download, install, and start coding with Claude.

## Features

- **Zero Setup**: Single installer includes Node.js runtime and all dependencies
- **Visual Chat Interface**: Clean, modern UI for conversing with Claude
- **File Operations Made Easy**: See file changes before approving them with visual diffs
- **Action Approval**: Click buttons instead of typing "yes/no" for approvals
- **Project Management**: Pick working directories with file browser, not terminal commands
- **Conversation History**: Save and resume past coding sessions
- **Auto-Updates**: Stay current with automatic updates via GitLab Releases
- **Cross-Platform**: Works on Windows, macOS, and Linux

## Tech Stack

- **Electron 40+** - Desktop application framework
- **Vue 3 + TypeScript** - Modern, reactive UI
- **Tailwind CSS** - Utility-first styling
- **Electron Forge** - Build and packaging pipeline
- **@anthropic-ai/claude-code** - Official Claude Code CLI

## Project Status

**Current Phase**: Planning  
See [plan.md](./plan.md) for detailed implementation roadmap.

## Development Roadmap

### Phase 1: Foundation (2-3 days)
- Set up Electron + Vue project structure
- Create basic chat UI
- Configure development environment

### Phase 2: Claude Integration (3-4 days)
- Connect to Anthropic API
- Implement message streaming
- Add settings panel for API key

### Phase 3: File Operations (4-5 days)
- Build file tree browser
- Create diff viewer for file changes
- Implement action approval workflow

### Phase 4: Polish (3-4 days)
- Add conversation history
- Improve error handling
- Optimize performance

### Phase 5: Distribution (3-4 days)
- Create installers for all platforms
- Set up auto-update system
- Test on clean machines

**Total Estimated Time**: 15-20 days for MVP

## Installation (Future)

### Windows
Download `Philibert-Setup.exe` from [Releases](https://dev.web.wr0ng.name/wrongname/philibert/-/releases) and run the installer.

### macOS
Download `Philibert.dmg` from [Releases](https://dev.web.wr0ng.name/wrongname/philibert/-/releases), open it, and drag the app to Applications.

### Linux
Download your preferred package:
- `.deb` for Debian/Ubuntu: `sudo dpkg -i philibert_1.0.0_amd64.deb`
- `.rpm` for Fedora/RHEL: `sudo rpm -i philibert-1.0.0.x86_64.rpm`
- `.AppImage` for universal: `chmod +x Philibert-1.0.0.AppImage && ./Philibert-1.0.0.AppImage`

## Usage (Future)

1. Launch Philibert
2. Enter your Anthropic API key in Settings
3. Select a working directory for your project
4. Start chatting with Claude!
5. Review and approve file changes before they're executed
6. Watch your code come to life

## Development Setup

### Prerequisites
- Node.js 20+ (for development only)
- npm 10+

### Getting Started
```bash
# Clone the repository
git clone https://dev.web.wr0ng.name/wrongname/philibert.git
cd philibert

# Install dependencies
npm install

# Start development server
npm run start
```

### Build Commands
```bash
# Package app (no installer)
npm run package

# Create platform-specific installers
npm run make

# Run linter
npm run lint

# Type checking
npm run typecheck
```

## Architecture

```
Electron App
├── Main Process (Node.js)
│   ├── Claude Code Service (wraps @anthropic-ai/claude-code)
│   ├── File Watcher Service
│   ├── Config Service (secure API key storage)
│   └── IPC Handlers
│
└── Renderer Process (Vue 3)
    ├── Chat Interface
    ├── File Browser
    ├── Settings Panel
    └── Action Approval UI
```

## Security

- API keys encrypted at rest using Electron's safeStorage
- Context isolation enabled (no direct Node.js access from renderer)
- All IPC communication through secure contextBridge
- File system access limited to user-selected directories
- Code signing for macOS and Windows installers

## Contributing

This project is in early development. Contributions welcome once MVP is complete.

## License

TBD

## Acknowledgments

- Built on top of [@anthropic-ai/claude-code](https://www.npmjs.com/package/@anthropic-ai/claude-code)
- Powered by [Anthropic's Claude AI](https://www.anthropic.com/claude)
- UI framework: [Vue.js](https://vuejs.org/)
- Desktop framework: [Electron](https://www.electronjs.org/)

---

**Note**: This is a community project and is not officially affiliated with Anthropic.
