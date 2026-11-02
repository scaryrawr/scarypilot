import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const guidance = [
  "Use uv for Python work. In a uv project, run `uv run python script.py` or `uv run python -m module`; uv uses the project's environment.",
  "For a standalone script, use `uv run --no-project python script.py`. For a temporary dependency, use `uv run --with package python script.py`.",
  "For project dependencies, use `uv add package` only when changing the project is intended. For an existing virtual environment, use `uv pip install package` rather than bare pip. Preserve the project's environment and dependency conventions; do not use --system by default.",
  "For project tools such as pytest and ruff, use `uv run pytest` or `uv run ruff` so they use the project environment. For a tool independent of project dependencies, use `uvx tool`, equivalent to `uv tool run tool`; its tool environment may not include the project's packages.",
  "For pipx-style one-off execution, consider `uvx tool`. For an intended persistent tool installation, use `uv tool install package`. Existing pipx installations are separate; do not assume uv manages them or replace them without permission.",
  "`uv run` can synchronize environments, and uv or uvx can download Python or dependencies. Follow project instructions and obtain permission for changes or network access when required.",
  "Check `uv --version` before relying on uv. If uv is unavailable, report the prerequisite and follow the user's installation instructions or ask before installing it.",
].join(" ");

function commandWords(command) {
  const words = [];
  let word = "";
  let quoted = false;
  let quote = "";
  let escaped = false;
  let comment = false;

  const finishWord = () => {
    if (word || quoted) words.push({ word, quoted });
    word = "";
    quoted = false;
  };

  for (const char of command) {
    if (comment) {
      if (char === "\n") {
        comment = false;
        words.push({ separator: true });
      }
    } else if (escaped) {
      word += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      quoted = true;
    } else if (char === "#" && !word) {
      comment = true;
    } else if (";|&\n".includes(char)) {
      finishWord();
      words.push({ separator: true });
    } else if (/\s/.test(char)) {
      finishWord();
    } else {
      word += char;
    }
  }

  finishWord();

  return words;
}

function usesDirectPythonTool(command) {
  const heredoc = command.indexOf("<<");
  const commandPrefix = heredoc === -1 ? command : command.slice(0, heredoc);
  let atCommand = true;

  for (const token of commandWords(commandPrefix)) {
    if (token.separator) {
      atCommand = true;
    } else if (atCommand && !token.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.word)) {
      continue;
    } else if (atCommand) {
      if (!token.quoted && /^(?:python(?:\d+(?:\.\d+)*)?|pip(?:\d+(?:\.\d+)*)?|pipx|pytest|ruff)$/.test(token.word)) return true;
      atCommand = false;
    }
  }

  return false;
}

function readEvent() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch (error) {
    console.error(`uv hook could not read its event: ${error.message}`);
    process.exit(1);
  }
}

const event = readEvent();

let output = {};

if (process.argv[2] === "session" && event && typeof event === "object") {
  const uv = spawnSync("uv", ["--version"], { stdio: "ignore" });
  let availability = "";

  if (uv.error?.code === "ENOENT") {
    availability = "uv was not found on PATH for this hook. ";
  } else if (uv.error || uv.status !== 0) {
    availability = `The uv availability check failed${uv.error ? `: ${uv.error.message}` : ` with exit code ${uv.status}`}. `;
  }

  output = { additionalContext: availability + guidance };
} else if ((process.argv[2] === "shell" || process.argv[2] === "failure") && event && typeof event === "object") {
  let args = event.toolArgs;

  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch (error) {
      console.error(`uv hook could not parse tool arguments: ${error.message}`);
      process.exit(1);
    }
  }

  if ((event.toolName === "bash" || event.toolName === "powershell") &&
      args && typeof args.command === "string" && usesDirectPythonTool(args.command)) {
    const message = `A Python command or tool was invoked directly. ${guidance}`;

    if (process.argv[2] === "failure") {
      process.stdout.write(message);
      process.exit(2);
    }

    output = { additionalContext: message };
  }
}

process.stdout.write(JSON.stringify(output));
