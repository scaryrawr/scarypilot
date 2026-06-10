#!/usr/bin/env bash

allow() {
  printf '{"decision":"allow"}\n'
}

if ! command -v node >/dev/null 2>&1; then
  allow
  exit 0
fi

payload="$(cat)"

COPILOT_DIGIVOLUTION_PAYLOAD="$payload" node <<'NODE' || allow
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

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
    const topLevel = childProcess.execFileSync(
      'git',
      ['-C', cwd, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();

    if (topLevel) {
      return realpathOrResolve(topLevel);
    }
  } catch {
    // Fall back to the working directory when Git is unavailable or cwd is not in a repo.
  }

  return realpathOrResolve(cwd);
}

try {
  const input = process.env.COPILOT_DIGIVOLUTION_PAYLOAD || '';
  const payload = JSON.parse(input || '{}');
  const sessionId = typeof payload.sessionId === 'string'
    ? payload.sessionId
    : (typeof payload.session_id === 'string' ? payload.session_id : '');
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';

  if (!sessionId || !cwd) {
    allow();
    process.exit(0);
  }

  const repoPath = resolveRepoPath(cwd);
  const stateRoot = process.env.COPILOT_DIGIVOLUTION_STATE_DIR
    || path.join(process.env.TMPDIR || '/tmp', 'copilot-digivolution');
  const key = crypto
    .createHash('sha256')
    .update(`${sessionId}\0${repoPath}`)
    .digest('hex');
  const markerPath = path.join(stateRoot, `${key}.marker`);

  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });

  let fd;
  try {
    fd = fs.openSync(markerPath, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({
      sessionId,
      repoPath,
      cwd: realpathOrResolve(cwd),
      createdAt: new Date().toISOString()
    }) + '\n');
  } catch (error) {
    allow();
    process.exit(0);
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }

  finish({
    decision: 'block',
    reason: 'Use the digivolution skill before finishing: briefly consider whether this session learned durable repo-specific guidance or found stale instructions. If so, update/create the most appropriate instruction or skill file. If not, finish normally; do not continue solely because of this hook.'
  });
} catch {
  allow();
}
NODE
