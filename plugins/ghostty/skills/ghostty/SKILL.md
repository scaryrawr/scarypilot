---
name: ghostty
description: Create Ghostty windows/tabs/splits and drive terminals with focus/input for multitasking workflows on macOS.
---

# Ghostty Skill

Use Ghostty automation helpers to create terminal contexts and run commands in parallel workflows.

## Command contract (v1)

Use `plugins/ghostty/skills/ghostty/scripts/ghostty-control.sh`:

```bash
# Create a new context
plugins/ghostty/skills/ghostty/scripts/ghostty-control.sh new \
  --location window|tab|split:left|split:right|split:up|split:down \
  [--command "command to run"] \
  [--working-directory /path] \
  [--env KEY=VALUE ...]

# Focus a terminal
plugins/ghostty/skills/ghostty/scripts/ghostty-control.sh focus \
  [--target "selector text"]

# Send input to a terminal
plugins/ghostty/skills/ghostty/scripts/ghostty-control.sh input \
  --text "input text" \
  [--target "selector text"] \
  [--submit]
```

Engine selection:

- Default `--engine auto`: Shortcuts/App Intents first, then AppleScript fallback.
- Explicit engine override: `--engine shortcuts` or `--engine applescript`.

## App Intents (preferred path)

The shortcuts wrapper expects user shortcuts with these names (overridable via env vars):

- `Ghostty New Terminal` (`GHOSTTY_SHORTCUT_NEW_TERMINAL`)
- `Ghostty Focus Terminal` (`GHOSTTY_SHORTCUT_FOCUS_TERMINAL`)
- `Ghostty Input Text` (`GHOSTTY_SHORTCUT_INPUT_TEXT`)

Payload fields sent to shortcuts:

- `new`: `action`, `location`, `command`, `workingDirectory`, `env[]`
- `focus`: `action`, `target`
- `input`: `action`, `target`, `text`, `submit`

## Safety and execution rules

1. Check capabilities first:

   ```bash
   plugins/ghostty/skills/ghostty/scripts/ghostty-capabilities.sh
   ```

2. Before any action, print the exact command you are about to run.
3. Quote all user-provided values.
4. For `input`, always include the resolved target context in your response:
   - explicit selector (`--target "..."`) when using shortcuts
   - "active/frontmost terminal" when using AppleScript fallback
5. If fallback cannot safely satisfy the request (for example targeted focus/input without shortcuts), fail loudly and explain why.

## Examples

```bash
# New tab running logs
plugins/ghostty/skills/ghostty/scripts/ghostty-control.sh new \
  --location tab \
  --command "tail -f /var/log/system.log"

# New split for test runner
plugins/ghostty/skills/ghostty/scripts/ghostty-control.sh new \
  --location split:right \
  --working-directory "$PWD" \
  --command "npm test"

# Focus and send command to named target (shortcuts path)
plugins/ghostty/skills/ghostty/scripts/ghostty-control.sh focus --target "backend"
plugins/ghostty/skills/ghostty/scripts/ghostty-control.sh input \
  --target "backend" \
  --text "npm run dev" \
  --submit
```

