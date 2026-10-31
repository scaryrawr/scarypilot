# uv

This plugin guides Copilot CLI to use [uv](https://docs.astral.sh/uv/) for Python. It adds session and subagent guidance and feedback after supported shell calls that invoke `python`, `pip`, `pipx`, `pytest`, or `ruff` directly.

## Prerequisites

Install Node.js and [uv](https://docs.astral.sh/uv/getting-started/installation/) on the machine running Copilot. Both must be on `PATH`. The session guidance reports when the hook cannot find uv. The plugin does not install uv, Python, or packages.

## Install

```sh
copilot plugin marketplace add scaryrawr/scarypilot
copilot plugin install uv@scarypilot
```

Start a new Copilot session after installing the plugin.

## Use

In a uv project, use the project's environment:

```sh
uv run python script.py
uv run python -m pytest
uv run pytest
uv run ruff check .
```

For a script outside a project, use `uv run --no-project python script.py`. For a temporary dependency, use `uv run --with requests python script.py`.

When you intend to change project dependencies, use `uv add requests`. To install into an existing virtual environment, use `uv pip install requests`. Follow the project's own dependency and environment conventions. `uv pip install` needs a virtual environment unless you explicitly choose another supported target. Do not use `--system` as a default.

For a one-off tool that does not need the project's dependencies, use `uvx ruff check .`. `uvx` is an alias for `uv tool run` and uses a tool environment that may not include the project's packages. When you intend to install a tool persistently, use `uv tool install ruff`. Existing pipx installations remain separate from uv's tools.

`uv run` can create or synchronize a project environment. uv and uvx can download Python or dependencies. Check the project's instructions and the user's permission before making changes or using the network.

## Limits

The hooks supply guidance, not enforcement. The shell hooks run after successful or failed `bash` or `powershell` tool calls and add guidance for direct `python`, `pip`, `pipx`, `pytest`, and `ruff` commands, including versioned `python` and `pip` names such as `python3` and `pip3`. They do not change or block commands. The conservative scan is not a shell parser. It checks only the text before the first here-document marker, and can miss commands in wrappers, substitutions, scripts, aliases, quoted command names, or other tools. It can also report a match for shell syntax it does not understand. The plugin cannot guarantee that an agent uses uv. Copilot CLI does not emit `subagentStart` for its built-in `general-purpose` agent.

Plugin hooks are a Copilot CLI feature. Copilot in the cloud loads repository hooks, not installed plugin hooks. See the [Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference) and [uv documentation](https://docs.astral.sh/uv/).

Run the hook protocol tests with `node --test plugins/uv/hooks/guide.test.mjs`.
