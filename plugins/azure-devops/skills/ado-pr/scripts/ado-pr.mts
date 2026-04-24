#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

type ParsedArgs = {
  command?: string;
  positionals: string[];
  flags: Map<string, string[]>;
};

type PullRequestDetails = {
  pullRequestId?: number;
  title?: string;
  status?: string;
  isDraft?: boolean;
  sourceRefName?: string;
  targetRefName?: string;
  repository?: {
    id?: string;
    name?: string;
    project?: {
      id?: string;
      name?: string;
    };
  };
  createdBy?: {
    displayName?: string;
    uniqueName?: string;
  };
  url?: string;
};

type ThreadComment = {
  parentCommentId: number;
  content: string;
  commentType: 'text';
};

type ThreadPayload = {
  comments: ThreadComment[];
  status: string;
  threadContext?: {
    filePath: string;
    rightFileStart: {
      line: number;
      offset: number;
    };
    rightFileEnd: {
      line: number;
      offset: number;
    };
  };
};

const HELP_TOKENS = new Set(['help', '--help', '-h']);
const HELP_TEXT = `Usage:
  ./scripts/ado-pr.mts context --id <pr-id> [--detect true|false] [--org <org-url>]
  ./scripts/ado-pr.mts list-threads --id <pr-id> [--status active] [--detect true|false] [--org <org-url>]
  ./scripts/ado-pr.mts thread-payload --content <text> [--status active] [--file-path <path> --line-start <n> --line-end <n>] [--out-file <path>]`;

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const next = rest[index + 1];
      const values = flags.get(name) ?? [];
      if (next === undefined || next.startsWith('--')) {
        values.push('true');
      } else {
        values.push(next);
        index += 1;
      }
      flags.set(name, values);
      continue;
    }

    positionals.push(token);
  }

  return { command, positionals, flags };
}

function getFlag(args: ParsedArgs, name: string): string | undefined {
  const values = args.flags.get(name);
  return values?.[values.length - 1];
}

function wantsHelp(args: ParsedArgs): boolean {
  return (
    args.command === undefined ||
    HELP_TOKENS.has(args.command) ||
    getFlag(args, 'help') === 'true' ||
    (args.positionals.length === 1 && HELP_TOKENS.has(args.positionals[0] ?? ''))
  );
}

function getRequiredFlag(args: ParsedArgs, name: string): string {
  const value = getFlag(args, name);
  if (!value) {
    throw new Error(`Missing required flag --${name}`);
  }
  return value;
}

function describeCommandError(error: unknown): string {
  if (error && typeof error === 'object') {
    if ('stderr' in error) {
      const stderr = error.stderr;
      if (typeof stderr === 'string' && stderr.trim()) {
        return stderr.trim();
      }
      if (stderr instanceof Buffer) {
        const text = stderr.toString('utf8').trim();
        if (text) {
          return text;
        }
      }
    }

    if ('message' in error && typeof error.message === 'string') {
      return error.message;
    }
  }

  return 'Unknown command failure';
}

function runCommand(binary: string, commandArgs: string[]): string {
  try {
    return execFileSync(binary, commandArgs, { encoding: 'utf8' }).trim();
  } catch (error) {
    throw new Error(`${binary} ${commandArgs.join(' ')} failed: ${describeCommandError(error)}`);
  }
}

function runAz(commandArgs: string[]): string {
  return runCommand('az', commandArgs);
}

function runAzJson<T>(commandArgs: string[]): T {
  const output = runAz([...commandArgs, '--output', 'json']);
  return JSON.parse(output) as T;
}

function buildScopeArgs(args: ParsedArgs): string[] {
  const org = getFlag(args, 'org');
  if (org) {
    return ['--org', org];
  }

  const detect = getFlag(args, 'detect') ?? 'true';
  return ['--detect', detect];
}

function parseLineNumber(value: string, flagName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Expected --${flagName} to be a positive integer`);
  }
  return parsed;
}

function buildThreadPayload(args: ParsedArgs): ThreadPayload {
  const content = getRequiredFlag(args, 'content');
  const status = getFlag(args, 'status') ?? 'active';
  const filePath = getFlag(args, 'file-path');
  const lineStartValue = getFlag(args, 'line-start');
  const lineEndValue = getFlag(args, 'line-end');

  const payload: ThreadPayload = {
    comments: [
      {
        parentCommentId: 0,
        content,
        commentType: 'text'
      }
    ],
    status
  };

  if (filePath) {
    if (!lineStartValue) {
      throw new Error('File-specific thread payloads require --line-start');
    }

    const lineStart = parseLineNumber(lineStartValue, 'line-start');
    const lineEnd = lineEndValue ? parseLineNumber(lineEndValue, 'line-end') : lineStart;
    if (lineEnd < lineStart) {
      throw new Error('--line-end must be greater than or equal to --line-start');
    }

    payload.threadContext = {
      filePath,
      rightFileStart: { line: lineStart, offset: 0 },
      rightFileEnd: { line: lineEnd, offset: 0 }
    };
  }

  return payload;
}

function printUsage(useStderr = false): void {
  const write = useStderr ? console.error : console.log;
  write(HELP_TEXT);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (wantsHelp(args)) {
    printUsage();
    return;
  }

  switch (args.command) {
    case 'context': {
      const prId = getRequiredFlag(args, 'id');
      const details = runAzJson<PullRequestDetails>(['repos', 'pr', 'show', '--id', prId, ...buildScopeArgs(args)]);
      console.log(
        JSON.stringify(
          {
            pullRequestId: details.pullRequestId,
            title: details.title,
            status: details.status,
            isDraft: details.isDraft ?? false,
            sourceBranch: details.sourceRefName,
            targetBranch: details.targetRefName,
            repositoryId: details.repository?.id,
            repositoryName: details.repository?.name,
            projectId: details.repository?.project?.id,
            projectName: details.repository?.project?.name,
            createdBy: details.createdBy?.uniqueName ?? details.createdBy?.displayName,
            url: details.url
          },
          null,
          2
        )
      );
      return;
    }
    case 'list-threads': {
      const prId = getRequiredFlag(args, 'id');
      const desiredStatus = getFlag(args, 'status');
      const details = runAzJson<PullRequestDetails>(['repos', 'pr', 'show', '--id', prId, ...buildScopeArgs(args)]);
      const projectName = details.repository?.project?.name;
      const repositoryId = details.repository?.id;
      if (!projectName || !repositoryId) {
        throw new Error('Could not determine project or repository for the pull request');
      }

      const response = runAzJson<{ value?: Array<Record<string, unknown>> }>([
        'devops',
        'invoke',
        '--area',
        'git',
        '--resource',
        'pullRequestThreads',
        '--route-parameters',
        `project=${projectName}`,
        `repositoryId=${repositoryId}`,
        `pullRequestId=${prId}`,
        '--api-version',
        '7.1',
        ...buildScopeArgs(args)
      ]);
      const threads = response.value ?? [];
      const filteredThreads = desiredStatus
        ? threads.filter((thread) => thread.status === desiredStatus)
        : threads;

      console.log(JSON.stringify({ count: filteredThreads.length, threads: filteredThreads }, null, 2));
      return;
    }
    case 'thread-payload': {
      const payload = buildThreadPayload(args);
      const outFile = getFlag(args, 'out-file');
      if (outFile) {
        await writeFile(outFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        console.log(JSON.stringify({ outFile, payload }, null, 2));
      } else {
        console.log(JSON.stringify(payload, null, 2));
      }
      return;
    }
    default:
      printUsage(true);
      throw new Error(`Unknown command: ${args.command ?? '<none>'}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
