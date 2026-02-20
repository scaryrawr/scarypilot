# Ghostty Plugin

Control Ghostty on macOS so agents can open windows, tabs, and splits, then focus terminals and send input for multitasking workflows.

## What This Plugin Does

- Creates new Ghostty contexts: window, tab, split:right, and split:down
- Supports full split location contract (`split:left|right|up|down`) when App Intents are available via Shortcuts
- Focuses a target terminal (App Intents path)
- Sends input to a terminal (App Intents path) or to the active terminal (AppleScript fallback)
- Runs commands in new contexts by injecting shell input

## Prerequisites

- **macOS**
- **Ghostty** installed
- **Optional but recommended:** `shortcuts` CLI with three configured shortcuts:
  - `Ghostty New Terminal`
  - `Ghostty Focus Terminal`
  - `Ghostty Input Text`
- **Fallback path:** `osascript` with Accessibility permissions for System Events keystrokes

## Installation

```bash
copilot plugin marketplace add scaryrawr/scarypilot
copilot plugin install ghostty@scarypilot
```

## Usage

The skill uses helper scripts in `plugins/ghostty/skills/ghostty/scripts/`.

```bash
# Check available automation engines
plugins/ghostty/skills/ghostty/scripts/ghostty-capabilities.sh

# Create a split and run a command (auto engine: shortcuts first, AppleScript fallback)
plugins/ghostty/skills/ghostty/scripts/ghostty-control.sh new \
  --location split:right \
  --command "npm test"

# Focus a target terminal by selector text (shortcuts engine expected)
plugins/ghostty/skills/ghostty/scripts/ghostty-control.sh focus --target "server"

# Send input and submit Enter
plugins/ghostty/skills/ghostty/scripts/ghostty-control.sh input \
  --target "server" \
  --text "npm run dev" \
  --submit
```

## Notes

- Auto mode prefers App Intents via Shortcuts and falls back to AppleScript.
- AppleScript fallback is intentionally limited: `split:left` and `split:up` are not supported by default keybindings, and targeted focus/input is not reliable without App Intents.

## Resources

- [Ghostty macOS App Intents source](https://github.com/ghostty-org/ghostty/tree/main/macos/Sources/Features/App%20Intents)
- [Ghostty project](https://github.com/ghostty-org/ghostty)

