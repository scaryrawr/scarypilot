#!/usr/bin/env node

/**
 * Shared hook logic for the digivolution plugin.
 *
 * Two modes drive a single per-prompt "pending reflection" flag, stored as a
 * marker file keyed by `sessionId + repoPath`:
 *
 *   - `mark`    (userPromptSubmitted): create/refresh the marker. A real user
 *               prompt arms one reflection nudge for the work that follows.
 *   - `reflect` (agentStop): if the marker exists, clear it and block once so
 *               the agent reflects; otherwise allow the turn to finish.
 *
 * Loop safety: if the forced continuation produced by a `block` is surfaced
 * through `userPromptSubmitted`, `mark` recognizes this hook's own prompt and
 * does not re-arm the flag. The next `agentStop` finds no marker and allows —
 * at most one forced continuation per user prompt.
 *
 * The hook never edits files or overrides agent judgement; it only emits an
 * advisory `block` reason. Any unexpected error falls back to `allow` so the
 * session is never wedged by hook failures.
 *
 * Usage: `node digivolution.mjs <mark|reflect>` with the hook payload on stdin.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';

/** Matches a canonical session UUID (real main-agent sessions). */
const SESSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Advisory nudge emitted at most once per user prompt. */
const REFLECT_REASON =
  'Optional digivolution check before finishing: silently decide whether this ' +
  'work revealed durable, repo-specific guidance worth recording — or stale ' +
  'instructions worth fixing. If yes, use the digivolution skill to update the ' +
  'most appropriate AGENTS.md, Copilot instruction, or in-repo skill file, then ' +
  'explain only the update you made. If no update is needed, end this ' +
  'continuation with no user-visible response: do not say that no changes are ' +
  'needed, do not recap, and do not acknowledge this note.';

const REFLECT_REASON_PREFIX = 'Optional digivolution check before finishing:';

function allow() {
  process.stdout.write('{"decision":"allow"}\n');
}

function finish(output) {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function realpathOrResolve(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function resolveRepoPath(cwd) {
  try {
    const topLevel = childProcess
      .execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      .trim();

    if (topLevel) {
      return realpathOrResolve(topLevel);
    }
  } catch {
    // Fall back to the working directory when Git is unavailable or cwd is not in a repo.
  }

  return realpathOrResolve(cwd);
}

function readPayload() {
  const input = process.env.COPILOT_DIGIVOLUTION_PAYLOAD;
  if (typeof input === 'string') {
    return input;
  }

  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Resolve the marker path for this session/repo, or null when the payload does
 * not describe a genuine main-agent session (missing fields or a sub-agent id).
 */
function resolveMarker(payload) {
  const sessionId =
    typeof payload.sessionId === 'string'
      ? payload.sessionId
      : typeof payload.session_id === 'string'
        ? payload.session_id
        : '';
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';

  if (!sessionId || !cwd) {
    return null;
  }

  // Task-tool sub-agents fire with sessionId set to their tool-call id
  // (e.g. "call_..."); only act on canonical main-agent session UUIDs.
  if (!SESSION_UUID.test(sessionId)) {
    return null;
  }

  const repoPath = resolveRepoPath(cwd);
  const stateRoot =
    process.env.COPILOT_DIGIVOLUTION_STATE_DIR ||
    path.join(process.env.TMPDIR || '/tmp', 'copilot-digivolution');
  const key = crypto
    .createHash('sha256')
    .update(`${sessionId}\0${repoPath}`)
    .digest('hex');

  return {
    sessionId,
    repoPath,
    cwd: realpathOrResolve(cwd),
    stateRoot,
    markerPath: path.join(stateRoot, `${key}.marker`),
  };
}

function isSelfReflectionPrompt(payload) {
  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';

  return (
    prompt.startsWith(REFLECT_REASON_PREFIX) &&
    prompt.includes('use the digivolution skill')
  );
}

/** userPromptSubmitted: arm one reflection nudge for the upcoming work. */
function mark(marker) {
  fs.mkdirSync(marker.stateRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    marker.markerPath,
    `${JSON.stringify({
      sessionId: marker.sessionId,
      repoPath: marker.repoPath,
      cwd: marker.cwd,
      updatedAt: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
}

/** agentStop: block once if a reflection is pending, then clear the flag. */
function reflect(marker) {
  let pending = false;
  try {
    fs.unlinkSync(marker.markerPath);
    pending = true;
  } catch {
    // No marker (or already cleared) -> nothing pending, allow the turn to end.
    pending = false;
  }

  if (pending) {
    finish({ decision: 'block', reason: REFLECT_REASON });
  } else {
    allow();
  }
}

function main() {
  const mode = process.argv[2];

  let payload;
  try {
    payload = JSON.parse(readPayload() || '{}');
  } catch {
    allow();
    return;
  }

  const marker = resolveMarker(payload);

  if (mode === 'mark') {
    // userPromptSubmitted output is not processed; only side effects matter.
    if (marker && !isSelfReflectionPrompt(payload)) {
      try {
        mark(marker);
      } catch {
        // Best effort: a missing flag simply means no nudge this prompt.
      }
    }
    return;
  }

  // Default to reflect (agentStop) semantics.
  if (!marker) {
    allow();
    return;
  }

  try {
    reflect(marker);
  } catch {
    allow();
  }
}

main();
