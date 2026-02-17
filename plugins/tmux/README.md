# tmux Plugin

Remote control tmux sessions for interactive CLIs (python, gdb, etc.) by sending keystrokes and scraping pane output.

## Attribution

This plugin is based on the tmux skill by [Armin Ronacher (mitsuhiko)](https://github.com/mitsuhiko/agent-stuff/tree/main/skills/tmux), licensed under Apache 2.0. The original work has been adapted for use as a Copilot plugin. Original implementation is "vibecoded" - created through AI-assisted development.

## License

This plugin is distributed under the Apache 2.0 License, in compliance with the original work's license.

Original work: Copyright (c) Armin Ronacher  
Plugin adaptation: Copyright (c) Mike Wallio

## Prerequisites

- **tmux** must be installed on your system
  - macOS: `brew install tmux`
  - Linux: `apt-get install tmux` or `yum install tmux`

## Installation

```bash
copilot plugin marketplace add scaryrawr/scarypilot
copilot plugin install tmux@scarypilot
```

## What It Does

The tmux plugin enables AI assistants to:

- Create isolated tmux sessions for interactive tools (Python REPL, debuggers, shells)
- Send keystrokes and commands to running processes
- Capture and analyze output from interactive sessions
- Synchronize with tool prompts using smart polling
- Manage multiple concurrent sessions safely

## Key Features

- **Isolated Sessions**: Uses private sockets to avoid interfering with user tmux sessions
- **Interactive Tool Support**: Works with Python REPL, gdb, lldb, psql, node REPL, and more
- **Smart Synchronization**: Helper scripts to wait for prompts and output
- **Session Discovery**: Find and manage all Claude-created tmux sessions
- **Safe Input Handling**: Proper escaping and literal sends to avoid shell expansion issues

## Usage Examples

The AI will automatically use this plugin when working with interactive tools. Some common scenarios:

- Debugging C/C++ programs with gdb/lldb
- Running Python code interactively
- Working with database shells (psql, mysql)
- Testing Node.js code in a REPL
- Any long-running interactive CLI tool

## Helper Scripts

The plugin includes two helper scripts:

- `wait-for-text.sh` - Poll a tmux pane for specific text with timeout
- `find-sessions.sh` - List and filter tmux sessions across sockets

These scripts are automatically used by the AI when appropriate.

## Monitoring Sessions

When the AI creates a tmux session, it will provide you with commands to monitor the session yourself, such as:

```bash
# Attach to the session
tmux -S /tmp/claude-tmux-sockets/claude.sock attach -t claude-python

# Or just capture the current output
tmux -S /tmp/claude-tmux-sockets/claude.sock capture-pane -p -J -t claude-python:0.0 -S -200
```

## Technical Details

- Sessions are created under `${TMPDIR:-/tmp}/claude-tmux-sockets/`
- Uses private sockets to isolate from user sessions
- Default socket: `claude.sock`
- Session naming convention: `claude-{tool}` (e.g., `claude-python`, `claude-gdb`)
