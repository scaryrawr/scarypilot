#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { normalizeAzureDevOpsOrganization } from '../../shared/azure-devops.mts';

type ParsedArgs = {
  command?: string;
  positionals: string[];
  flags: Map<string, string[]>;
};

type ParsedRemote = {
  organization: string;
  organizationUrl: string;
  project: string;
  repository: string;
  scheme: 'https' | 'ssh';
};

const DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';

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

function runCommand(binary: string, commandArgs: string[], cwd?: string): string {
  try {
    return execFileSync(binary, commandArgs, { cwd, encoding: 'utf8' }).trim();
  } catch (error) {
    throw new Error(`${binary} ${commandArgs.join(' ')} failed: ${describeCommandError(error)}`);
  }
}

function runAz(commandArgs: string[]): string {
  return runCommand('az', commandArgs);
}

function runGit(commandArgs: string[], cwd?: string): string {
  return runCommand('git', commandArgs, cwd);
}

function parseAzureRemote(remoteUrl: string): ParsedRemote | undefined {
  if (remoteUrl.startsWith('https://')) {
    const parsedUrl = new URL(remoteUrl);
    const isVisualStudioHost = parsedUrl.hostname.endsWith('.visualstudio.com');
    const isDevAzureHost = parsedUrl.hostname === 'dev.azure.com';

    if (isVisualStudioHost || isDevAzureHost) {
      let organization = '';
      let segments = parsedUrl.pathname.split('/').filter(Boolean);

      if (isDevAzureHost) {
        const [org, ...rest] = segments;
        if (!org) {
          return undefined;
        }
        organization = org;
        segments = rest;
      } else {
        organization = parsedUrl.hostname.replace(/\.visualstudio\.com$/, '');
        if (segments[0] === 'DefaultCollection') {
          segments = segments.slice(1);
        }
      }

      const project = segments[0];
      const resourceSection = segments[1];
      const repositoryIndex = segments[2] === '_optimized' ? 3 : 2;
      if (segments.length <= repositoryIndex) {
        return undefined;
      }

      const repository = segments[repositoryIndex];
      if (!project || resourceSection !== '_git' || !repository) {
        return undefined;
      }

      return {
        organization,
        organizationUrl: `https://dev.azure.com/${organization}`,
        project,
        repository,
        scheme: 'https'
      };
    }
  }

  const sshUrlMatch = /^ssh:\/\/git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(remoteUrl);
  if (sshUrlMatch) {
    const [, organization, project, repository] = sshUrlMatch;
    return {
      organization,
      organizationUrl: `https://dev.azure.com/${organization}`,
      project,
      repository,
      scheme: 'ssh'
    };
  }

  const sshScpMatch = /^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(remoteUrl);
  if (sshScpMatch) {
    const [, organization, project, repository] = sshScpMatch;
    return {
      organization,
      organizationUrl: `https://dev.azure.com/${organization}`,
      project,
      repository,
      scheme: 'ssh'
    };
  }

  return undefined;
}

function getRepoRoot(repoRootFlag?: string): string {
  return repoRootFlag ?? runGit(['rev-parse', '--show-toplevel']);
}

async function preflight(repoRootFlag?: string): Promise<void> {
  const repoRoot = getRepoRoot(repoRootFlag);
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  const head = runGit(['rev-parse', 'HEAD'], repoRoot);
  const statusOutput = runGit(['status', '--short'], repoRoot);
  const statusLines = statusOutput ? statusOutput.split('\n').filter(Boolean) : [];
  const conflictOutput = runGit(['diff', '--name-only', '--diff-filter=U'], repoRoot);
  const conflictFiles = conflictOutput ? conflictOutput.split('\n').filter(Boolean) : [];

  let originRemoteUrl: string | undefined;
  let hasOriginRemote = true;
  try {
    originRemoteUrl = runGit(['remote', 'get-url', 'origin'], repoRoot);
  } catch {
    hasOriginRemote = false;
  }

  let defaultBranch: string | undefined;
  try {
    const symbolicRef = runGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], repoRoot);
    defaultBranch = symbolicRef.split('/').at(-1);
  } catch {
    defaultBranch = undefined;
  }

  const blockers: string[] = [];
  const warnings: string[] = [];
  const isDetachedHead = branch === 'HEAD';
  if (isDetachedHead) {
    blockers.push('Detached HEAD');
  }
  if (conflictFiles.length > 0) {
    blockers.push('Merge conflicts present');
  }
  if (!hasOriginRemote) {
    blockers.push('No origin remote');
  }

  const parsedRemote = originRemoteUrl ? parseAzureRemote(originRemoteUrl) : undefined;
  if (originRemoteUrl && !parsedRemote) {
    blockers.push('Origin remote is not a recognized Azure DevOps remote');
  }
  if (defaultBranch && branch === defaultBranch) {
    warnings.push(`Current branch matches the default branch (${defaultBranch})`);
  }

  console.log(
    JSON.stringify(
      {
        repoRoot,
        branch,
        head,
        isDetachedHead,
        hasUncommittedChanges: statusLines.length > 0,
        statusLines,
        hasConflicts: conflictFiles.length > 0,
        conflictFiles,
        hasOriginRemote,
        originRemoteUrl,
        parsedRemote,
        defaultBranch,
        isOnDefaultBranch: defaultBranch ? branch === defaultBranch : false,
        blockers,
        warnings
      },
      null,
      2
    )
  );
}

async function findFirstExisting(paths: string[]): Promise<string | undefined> {
  for (const filePath of paths) {
    try {
      await access(filePath);
      return filePath;
    } catch {
      // Continue.
    }
  }
  return undefined;
}

async function discoverTemplate(args: ParsedArgs): Promise<void> {
  const repoRoot = getRepoRoot(getFlag(args, 'repo-root'));
  const targetBranch = getFlag(args, 'target-branch');
  const checked: string[] = [];

  const branchTemplateBases = [
    '.azuredevops/pull_request_template/branches',
    '.vsts/pull_request_template/branches',
    'docs/pull_request_template/branches',
    'pull_request_template/branches'
  ];
  const generalTemplates = [
    '.azuredevops/pull_request_template.md',
    '.azuredevops/pull_request_template.txt',
    '.vsts/pull_request_template.md',
    '.vsts/pull_request_template.txt',
    'docs/pull_request_template.md',
    'docs/pull_request_template.txt',
    'pull_request_template.md',
    'pull_request_template.txt'
  ];
  const additionalTemplateDirs = [
    '.azuredevops/pull_request_template',
    '.vsts/pull_request_template',
    'docs/pull_request_template',
    'pull_request_template'
  ];

  let foundPath: string | undefined;
  if (targetBranch) {
    const branchCandidates = branchTemplateBases.flatMap((basePath) => [
      join(repoRoot, basePath, `${targetBranch}.md`),
      join(repoRoot, basePath, `${targetBranch}.txt`)
    ]);
    checked.push(...branchCandidates);
    foundPath = await findFirstExisting(branchCandidates);
  }

  if (!foundPath) {
    const generalCandidates = generalTemplates.map((relativePath) => join(repoRoot, relativePath));
    checked.push(...generalCandidates);
    foundPath = await findFirstExisting(generalCandidates);
  }

  const additionalTemplates: string[] = [];
  for (const directory of additionalTemplateDirs) {
    const absoluteDirectory = join(repoRoot, directory);
    try {
      const entries = await readdir(absoluteDirectory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }
        if (!entry.name.endsWith('.md') && !entry.name.endsWith('.txt')) {
          continue;
        }
        additionalTemplates.push(join(absoluteDirectory, entry.name));
      }
    } catch {
      // Ignore missing directories.
    }
  }

  const selectedPath = foundPath ?? (additionalTemplates.length === 1 ? additionalTemplates[0] : undefined);
  const selectedContent = selectedPath ? await readFile(selectedPath, 'utf8') : undefined;

  console.log(
    JSON.stringify(
      {
        repoRoot,
        targetBranch,
        selectedPath,
        selectedContent,
        checked,
        additionalTemplates
      },
      null,
      2
    )
  );
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'preflight':
      await preflight(getFlag(args, 'repo-root'));
      return;
    case 'discover-template':
      await discoverTemplate(args);
      return;
    case 'upload-attachment':
      await uploadAttachment(args);
      return;
    default:
  console.error(`Usage:
  ./scripts/make-pr.mts preflight [--repo-root <path>]
  ./scripts/make-pr.mts discover-template [--repo-root <path>] [--target-branch <branch>]
  ./scripts/make-pr.mts upload-attachment --org <org-or-url> --project <project> --repository-id <id> --pull-request-id <id> --file <path> [--file-name <name>]`);
      throw new Error(`Unknown command: ${args.command ?? '<none>'}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
