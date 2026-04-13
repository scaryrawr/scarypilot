#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { normalizeAzureDevOpsOrganization } from '../../shared/azure-devops.mts';

type ParsedArgs = {
  command?: string;
  positionals: string[];
  flags: Map<string, string[]>;
};

type ResourceType = 'pull-request' | 'work-item' | 'unknown';

type ParsedAzureUrl = {
  url: string;
  host: string;
  organization: string;
  organizationUrl: string;
  project?: string;
  repository?: string;
  resourceType: ResourceType;
  resourceId?: number;
  pullRequestId?: number;
  workItemId?: number;
  routeSkill: 'ado-pr' | 'ado-work-items' | 'make-pr' | 'review-pr' | 'unknown';
  isVisualStudioHost: boolean;
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

function parseAzureDevOpsUrl(rawUrl: string): ParsedAzureUrl {
  const parsedUrl = new URL(rawUrl);
  const isVisualStudioHost = parsedUrl.hostname.endsWith('.visualstudio.com');
  const isDevAzureHost = parsedUrl.hostname === 'dev.azure.com';

  if (!isDevAzureHost && !isVisualStudioHost) {
    throw new Error(`Unsupported Azure DevOps host: ${parsedUrl.hostname}`);
  }

  let organization = '';
  let segments = parsedUrl.pathname.split('/').filter(Boolean);

  if (isDevAzureHost) {
    const [org, ...rest] = segments;
    if (!org) {
      throw new Error(`Could not determine organization from ${rawUrl}`);
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
  const parsed: ParsedAzureUrl = {
    url: rawUrl,
    host: parsedUrl.hostname,
    organization,
    organizationUrl: `https://dev.azure.com/${organization}`,
    project,
    resourceType: 'unknown',
    routeSkill: 'unknown',
    isVisualStudioHost
  };

  if (resourceSection === '_git') {
    const repositoryIndex = segments[2] === '_optimized' ? 3 : 2;
    const repository = segments[repositoryIndex];
    if (segments[repositoryIndex + 1] === 'pullrequest') {
      if (!repository) {
        throw new Error(`Could not determine repository from ${rawUrl}`);
      }

      const pullRequestId = Number.parseInt(segments[repositoryIndex + 2] ?? '', 10);
      if (!Number.isFinite(pullRequestId)) {
        throw new Error(`Could not determine pull request id from ${rawUrl}`);
      }

      return {
        ...parsed,
        repository,
        resourceType: 'pull-request',
        resourceId: pullRequestId,
        pullRequestId,
        routeSkill: 'ado-pr'
      };
    }
  }

  if (resourceSection === '_workitems' && segments[2] === 'edit') {
    const workItemId = Number.parseInt(segments[3] ?? '', 10);
    if (!Number.isFinite(workItemId)) {
      throw new Error(`Could not determine work item id from ${rawUrl}`);
    }

    return {
      ...parsed,
      resourceType: 'work-item',
      resourceId: workItemId,
      workItemId,
      routeSkill: 'ado-work-items'
    };
  }

  return parsed;
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

function printUsage(): void {
  console.error(`Usage:
  ./scripts/ado-cli.mts parse-url <azure-devops-url>
  ./scripts/ado-cli.mts upload-attachment --org <org-or-url> --project <project> --repository-id <id> --pull-request-id <id> --file <path> [--file-name <name>]`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'parse-url': {
      const [rawUrl] = args.positionals;
      if (!rawUrl) {
        throw new Error('Missing Azure DevOps URL');
      }
      console.log(JSON.stringify(parseAzureDevOpsUrl(rawUrl), null, 2));
      return;
    }
    case 'upload-attachment':
      await uploadAttachment(args);
      return;
    default:
      printUsage();
      throw new Error(`Unknown command: ${args.command ?? '<none>'}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
