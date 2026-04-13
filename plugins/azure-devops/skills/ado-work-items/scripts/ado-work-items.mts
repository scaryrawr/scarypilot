#!/usr/bin/env node

type ParsedArgs = {
  command?: string;
  positionals: string[];
  flags: Map<string, string[]>;
};

type ParsedWorkItemUrl = {
  url: string;
  host: string;
  organization: string;
  organizationUrl: string;
  project?: string;
  workItemId?: number;
};

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

function getRequiredFlag(args: ParsedArgs, name: string): string {
  const value = getFlag(args, name);
  if (!value) {
    throw new Error(`Missing required flag --${name}`);
  }
  return value;
}

function parseWorkItemUrl(rawUrl: string): ParsedWorkItemUrl {
  const parsedUrl = new URL(rawUrl);
  const isVisualStudioHost = parsedUrl.hostname.endsWith('.visualstudio.com');
  const isDevAzureHost = parsedUrl.hostname === 'dev.azure.com';

  if (!isVisualStudioHost && !isDevAzureHost) {
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
    if (segments[0]?.toLowerCase() === 'defaultcollection') {
      segments = segments.slice(1);
    }
  }

  const project = segments[0];
  if (segments[1] !== '_workitems' || segments[2] !== 'edit') {
    throw new Error(`URL is not a recognized work item URL: ${rawUrl}`);
  }

  const workItemId = Number.parseInt(segments[3] ?? '', 10);
  if (!Number.isFinite(workItemId)) {
    throw new Error(`Could not determine work item id from ${rawUrl}`);
  }

  return {
    url: rawUrl,
    host: parsedUrl.hostname,
    organization,
    organizationUrl: `https://dev.azure.com/${organization}`,
    project,
    workItemId
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function escapeWiqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function buildWiql(args: ParsedArgs): { wiql: string; command: string } {
  const fields = getFlag(args, 'fields') ?? 'System.Id,System.Title,System.State';
  const assignedTo = getFlag(args, 'assigned-to');
  const includedStates = getAllFlags(args, 'state');
  const excludedStates = getAllFlags(args, 'exclude-state');
  const workItemTypes = getAllFlags(args, 'type');
  const extraClauses = getAllFlags(args, 'extra-clause');

  const clauses: string[] = [];
  if (assignedTo) {
    clauses.push(`[System.AssignedTo] = ${assignedTo === '@Me' ? '@Me' : escapeWiqlStringLiteral(assignedTo)}`);
  }
  if (includedStates.length > 0) {
    clauses.push(`[System.State] IN (${includedStates.map(escapeWiqlStringLiteral).join(', ')})`);
  }
  for (const state of excludedStates) {
    clauses.push(`[System.State] <> ${escapeWiqlStringLiteral(state)}`);
  }
  if (workItemTypes.length > 0) {
    clauses.push(`[System.WorkItemType] IN (${workItemTypes.map(escapeWiqlStringLiteral).join(', ')})`);
  }
  clauses.push(...extraClauses);

  const whereClause = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  const wiql = `SELECT ${fields.split(',').map((field) => `[${field.trim()}]`).join(', ')} FROM workitems${whereClause} ORDER BY [System.ChangedDate] DESC`;
  const command = `az boards query --wiql ${shellQuote(wiql)} --detect true`;

  return { wiql, command };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'parse-url': {
      const [rawUrl] = args.positionals;
      if (!rawUrl) {
        throw new Error('Missing Azure DevOps work item URL');
      }
      console.log(JSON.stringify(parseWorkItemUrl(rawUrl), null, 2));
      return;
    }
    case 'wiql':
      console.log(JSON.stringify(buildWiql(args), null, 2));
      return;
    default:
      console.error(`Usage:
  ./scripts/ado-work-items.mts parse-url <work-item-url>
  ./scripts/ado-work-items.mts wiql [--assigned-to @Me] [--state Active] [--exclude-state Closed] [--type Bug] [--fields System.Id,System.Title,System.State] [--extra-clause "[System.AreaPath] UNDER 'Project\\Team'"]`);
      throw new Error(`Unknown command: ${args.command ?? '<none>'}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
