#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { normalizeAzureDevOpsOrganization } from '../../shared/azure-devops.mts';

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
  lastMergeSourceCommit?: {
    commitId?: string;
  };
  repository?: {
    id?: string;
    name?: string;
    project?: {
      id?: string;
      name?: string;
    };
  };
  reviewers?: Array<{
    displayName?: string;
    uniqueName?: string;
    vote?: number;
  }>;
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

const DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const HELP_TOKENS = new Set(['help', '--help', '-h']);
const HELP_TEXT = `Usage:
  ./scripts/review-pr.mts eligibility --id <pr-id> [--detect true|false] [--org <org-or-url>]
  ./scripts/review-pr.mts thread-payload --content <text> [--status active] [--file-path <path> --line-start <n> --line-end <n>] [--out-file <path>]
  ./scripts/review-pr.mts sync-labels --id <pr-id> --model <model-id> [--model <model-id>] [--detect true|false] [--org <org-or-url>]
  ./scripts/review-pr.mts code-link --org <org-or-url> --project <project> --repo <repo> --commit <sha> --file-path <path> --line-start <n> [--line-end <n>]
  ./scripts/review-pr.mts upload-attachment --org <org-or-url> --project <project> --repository-id <id> --pull-request-id <id> --file <path> [--file-name <name>]`;

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

function getAllFlags(args: ParsedArgs, name: string): string[] {
  return args.flags.get(name) ?? [];
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

function runGit(commandArgs: string[]): string {
  return runCommand('git', commandArgs);
}

function buildScopeArgs(args: ParsedArgs): string[] {
  const org = getFlag(args, 'org');
  if (org) {
    return ['--org', normalizeAzureDevOpsOrganization(org).organizationUrl];
  }

  const detect = getFlag(args, 'detect') ?? 'true';
  return ['--detect', detect];
}

function parseAzureRemoteOrganization(remoteUrl: string): string | undefined {
  const httpsDevMatch = /^https:\/\/dev\.azure\.com\/([^/]+)\//.exec(remoteUrl);
  if (httpsDevMatch) {
    return httpsDevMatch[1];
  }

  const httpsLegacyMatch = /^https:\/\/([^/.]+)\.visualstudio\.com\//.exec(remoteUrl);
  if (httpsLegacyMatch) {
    return httpsLegacyMatch[1];
  }

  const sshUrlMatch = /^ssh:\/\/git@ssh\.dev\.azure\.com:v3\/([^/]+)\//.exec(remoteUrl);
  if (sshUrlMatch) {
    return sshUrlMatch[1];
  }

  const sshScpMatch = /^git@ssh\.dev\.azure\.com:v3\/([^/]+)\//.exec(remoteUrl);
  if (sshScpMatch) {
    return sshScpMatch[1];
  }

  return undefined;
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

async function eligibility(args: ParsedArgs): Promise<void> {
  const prId = getRequiredFlag(args, 'id');
  const details = runAzJson<PullRequestDetails>(['repos', 'pr', 'show', '--id', prId, ...buildScopeArgs(args)]);
  const status = details.status ?? 'unknown';
  const eligible = status === 'active' && !(details.isDraft ?? false);

  console.log(
    JSON.stringify(
      {
        pullRequestId: details.pullRequestId,
        title: details.title,
        status,
        isDraft: details.isDraft ?? false,
        eligible,
        sourceBranch: details.sourceRefName,
        targetBranch: details.targetRefName,
        repositoryId: details.repository?.id,
        repositoryName: details.repository?.name,
        projectId: details.repository?.project?.id,
        projectName: details.repository?.project?.name,
        lastMergeSourceCommit: details.lastMergeSourceCommit?.commitId,
        reviewers: details.reviewers?.map((reviewer) => ({
          reviewer: reviewer.uniqueName ?? reviewer.displayName,
          vote: reviewer.vote ?? 0
        })) ?? [],
        url: details.url
      },
      null,
      2
    )
  );
}

async function syncLabels(args: ParsedArgs): Promise<void> {
  const prId = getRequiredFlag(args, 'id');
  const modelIds = getAllFlags(args, 'model');
  if (modelIds.length === 0) {
    throw new Error('Provide at least one --model value');
  }

  const details = runAzJson<PullRequestDetails>(['repos', 'pr', 'show', '--id', prId, ...buildScopeArgs(args)]);
  const repositoryId = details.repository?.id;
  const projectId = details.repository?.project?.id;
  if (!repositoryId || !projectId) {
    throw new Error('Could not determine repository or project for the pull request');
  }

  let organization = getFlag(args, 'org');
  if (!organization) {
    const remoteUrl = runGit(['remote', 'get-url', 'origin']);
    organization = parseAzureRemoteOrganization(remoteUrl);
  }
  if (!organization) {
    throw new Error('Could not determine organization; provide --org explicitly');
  }
  const normalizedOrganization = normalizeAzureDevOpsOrganization(organization);

  const accessToken = runAz([
    'account',
    'get-access-token',
    '--resource',
    DEVOPS_RESOURCE,
    '--query',
    'accessToken',
    '-o',
    'tsv'
  ]);

  const desiredLabels = [...new Set(['ai-reviewed', ...modelIds.map((modelId) => `ai-model-${modelId}`)])];
  const desiredLabelSet = new Set(desiredLabels);
  const endpoint = new URL(
    `https://dev.azure.com/${normalizedOrganization.organization}/${projectId}/_apis/git/repositories/${repositoryId}/pullRequests/${prId}/labels`
  );
  endpoint.searchParams.set('api-version', '7.1');

  const existingResponse = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
  if (!existingResponse.ok) {
    const detailsText = await existingResponse.text();
    throw new Error(`Fetching existing labels failed (${existingResponse.status}): ${detailsText}`);
  }

  const existingPayload = (await existingResponse.json()) as { value?: Array<{ name?: string }> };
  const existingLabels = new Set((existingPayload.value ?? []).flatMap((label) => (label.name ? [label.name] : [])));
  const addedLabels: string[] = [];
  const removedLabels: string[] = [];

  for (const label of existingLabels) {
    if (!label.startsWith('ai-model-') || desiredLabelSet.has(label)) {
      continue;
    }

    const deleteEndpoint = new URL(endpoint);
    deleteEndpoint.pathname = `${deleteEndpoint.pathname}/${encodeURIComponent(label)}`;

    const response = await fetch(deleteEndpoint, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      const detailsText = await response.text();
      throw new Error(`Removing label ${label} failed (${response.status}): ${detailsText}`);
    }

    removedLabels.push(label);
  }

  for (const label of desiredLabels) {
    if (existingLabels.has(label)) {
      continue;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: label })
    });

    if (!response.ok) {
      const detailsText = await response.text();
      throw new Error(`Adding label ${label} failed (${response.status}): ${detailsText}`);
    }

    addedLabels.push(label);
  }

  const finalResponse = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
  if (!finalResponse.ok) {
    const detailsText = await finalResponse.text();
    throw new Error(`Fetching final labels failed (${finalResponse.status}): ${detailsText}`);
  }

  const finalPayload = (await finalResponse.json()) as { value?: Array<{ name?: string }> };
  const finalLabels = (finalPayload.value ?? []).flatMap((label) => (label.name ? [label.name] : []));

  console.log(
    JSON.stringify(
      {
        organization: normalizedOrganization.organization,
        desiredLabels,
        addedLabels,
        removedLabels,
        finalLabels
      },
      null,
      2
    )
  );
}

function buildCodeLink(args: ParsedArgs): void {
  const organization = normalizeAzureDevOpsOrganization(getRequiredFlag(args, 'org')).organization;
  const project = getRequiredFlag(args, 'project');
  const repository = getRequiredFlag(args, 'repo');
  const commit = getRequiredFlag(args, 'commit');
  const rawFilePath = getRequiredFlag(args, 'file-path');
  const lineStart = parseLineNumber(getRequiredFlag(args, 'line-start'), 'line-start');
  const lineEnd = parseLineNumber(getFlag(args, 'line-end') ?? String(lineStart), 'line-end');
  const filePath = rawFilePath.startsWith('/') ? rawFilePath : `/${rawFilePath}`;

  const url = new URL(`https://dev.azure.com/${organization}/${project}/_git/${repository}`);
  url.searchParams.set('path', filePath);
  url.searchParams.set('version', `GC${commit}`);
  url.searchParams.set('lineStart', String(lineStart));
  url.searchParams.set('lineEnd', String(lineEnd));
  url.searchParams.set('lineStartColumn', '1');
  url.searchParams.set('lineEndColumn', '1');

  console.log(JSON.stringify({ url: url.toString() }, null, 2));
}

async function uploadAttachment(args: ParsedArgs): Promise<void> {
  const organization = normalizeAzureDevOpsOrganization(getRequiredFlag(args, 'org')).organization;
  const project = getRequiredFlag(args, 'project');
  const repositoryId = getRequiredFlag(args, 'repository-id');
  const pullRequestId = getRequiredFlag(args, 'pull-request-id');
  const filePath = getRequiredFlag(args, 'file');
  const fileName = getFlag(args, 'file-name') ?? basename(filePath);

  const fileStats = await stat(filePath);
  if (!fileStats.isFile()) {
    throw new Error(`${filePath} is not a regular file`);
  }

  const uploadUrl = new URL(
    `https://dev.azure.com/${organization}/${project}/_apis/git/repositories/${repositoryId}/pullRequests/${pullRequestId}/attachments/${encodeURIComponent(fileName)}`
  );
  uploadUrl.searchParams.set('api-version', '7.1');

  const accessToken = runAz([
    'account',
    'get-access-token',
    '--resource',
    DEVOPS_RESOURCE,
    '--query',
    'accessToken',
    '-o',
    'tsv'
  ]);

  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/octet-stream'
    },
    body: await readFile(filePath)
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Attachment upload failed (${response.status}): ${details}`);
  }

  const payload = (await response.json()) as { id?: number; url?: string };
  console.log(
    JSON.stringify(
      {
        fileName,
        filePath,
        id: payload.id,
        url: payload.url
      },
      null,
      2
    )
  );
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
    case 'eligibility':
      await eligibility(args);
      return;
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
    case 'sync-labels':
      await syncLabels(args);
      return;
    case 'code-link':
      buildCodeLink(args);
      return;
    case 'upload-attachment':
      await uploadAttachment(args);
      return;
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
