import { createHash } from "node:crypto";
import path from "node:path";

export const REFLECTION_PROMPT =
  "Run one digivolution review before finishing. Observable events in this turn " +
  "may have revealed a durable repository-specific setup, validation, workflow, " +
  "safety, convention, or instruction correction. Use the digivolution skill. " +
  "Make a guidance change only when the fact is verified and useful to future " +
  "agents; otherwise finish silently. Do not acknowledge this hook.";

const REFLECTION_PROMPT_PREFIX = "Run one digivolution review before finishing.";
const MAX_INSPECTED_TEXT = 8_192;

const CORRECTION_PATTERNS = [
  /\bi already (?:said|told you)\b/i,
  /\byou (?:ignored|missed|used)\b/i,
  /\bwhy did you (?:ignore|miss|use|run|change|remove|skip|retry)\b/i,
  /\bwhy are you (?:still )?(?:ignoring|missing|using|running|changing|removing|skipping|retrying)\b/i,
  /\byou keep (?:ignoring|missing|using|running|changing|removing|skipping|retrying)\b/i,
  /(?:^|[.!?]\s+|(?:also|and|but|just|please)\s+)remember(?:\s+(?:how|that|to))?\b/i,
  /\b(?:can|could|would) you (?:please )?remember\b/i,
  /\b(?:do not|don't) (?:do|use|run|change|remove|skip|retry) .{0,60}\bagain\b/i,
  /\bnext time[,;:\s-]+(?:use|run|check|read|follow|keep|avoid|do not|don't)\b/i,
  /\bfrom now on[,;:\s-]+(?:use|run|check|read|follow|keep|avoid|do not|don't)\b/i,
  /\bstop (?:using|running|doing|retrying)\b/i,
  /\b(?:no|wrong|incorrect)[,;:\s-]+(?:use|run|this|that)\b/i,
  /\b(?:this|the) (?:repo|repository) (?:uses|requires|expects)\b/i,
  /\bnot .{1,60}\b(?:use|run|uses|requires)\b/i,
] as const;

const REPO_SURFACE_PATTERN =
  /\b(?:repo(?:sitory)?|agents?\.md|claude\.md|copilot instructions?|skill\.md|readme(?:\.md)?|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|cargo\.toml|go\.mod|manifest|config(?:uration)? file|setup instructions?|install(?:ation)? instructions?|workflow file|project convention|npm|pnpm|yarn|bun|gradle|maven|cargo|pytest|rspec)\b/i;

const USAGE_ERROR_PATTERN =
  /\b(?:unknown|unrecognized|invalid|unsupported|unexpected)\s+(?:option|argument|flag|command)|\busage:\b|\bno such (?:script|command)\b|\bmissing required (?:argument|option)\b/i;

const PATH_KEYS = new Set([
  "path",
  "file",
  "filename",
  "cwd",
  "directory",
  "workdir",
  "workingdirectory",
]);

const LOCAL_COMMAND_TOOLS = new Set(["bash", "powershell"]);

type EvidenceKind =
  | "repo-correction"
  | "recovered-command-mistake"
  | "repeated-failure-recovered";

interface FailedOperation {
  readonly toolName: string;
  readonly argsDigest: string;
  readonly target: string;
  readonly usageError: boolean;
  readonly validationLike: boolean;
}

interface TurnState {
  reflectionIssued: boolean;
  evidence: Set<EvidenceKind>;
  failures: FailedOperation[];
}

export interface OperationInput {
  readonly toolName: string;
  readonly toolArgs: unknown;
  readonly workingDirectory: string;
}

export class TurnMonitor {
  private turn: TurnState | undefined;

  start(prompt: string): void {
    if (isReflectionPrompt(prompt)) return;

    this.turn = {
      reflectionIssued: false,
      evidence: new Set(),
      failures: [],
    };

    if (isRepositoryCorrection(prompt)) {
      this.turn.evidence.add("repo-correction");
    }
  }

  recordFailure(input: OperationInput, error: string): void {
    if (!this.turn || !LOCAL_COMMAND_TOOLS.has(input.toolName)) return;

    const operation = normalizeCommandOperation(input);
    if (!operation) return;

    this.turn.failures.push({
      toolName: input.toolName,
      argsDigest: digest(operation.command),
      target: operation.target,
      usageError: USAGE_ERROR_PATTERN.test(error.slice(0, MAX_INSPECTED_TEXT)),
      validationLike: operation.validationLike,
    });
  }

  recordSuccess(input: OperationInput): void {
    if (!this.turn || !LOCAL_COMMAND_TOOLS.has(input.toolName)) return;

    const operation = normalizeCommandOperation(input);
    if (!operation) return;

    const argsDigest = digest(operation.command);
    const related = this.turn.failures.filter(
      (failure) =>
        failure.toolName === input.toolName &&
        failure.target === operation.target &&
        failure.argsDigest !== argsDigest,
    );

    if (
      operation.validationLike &&
      related.some((failure) => failure.usageError && failure.validationLike)
    ) {
      this.turn.evidence.add("recovered-command-mistake");
    } else if (
      operation.validationLike &&
      related.filter((failure) => failure.validationLike).length >= 2
    ) {
      this.turn.evidence.add("repeated-failure-recovered");
    }
  }

  claimReflection(stopHookActive = false): boolean {
    if (
      stopHookActive ||
      !this.turn ||
      this.turn.reflectionIssued ||
      this.turn.evidence.size === 0
    ) {
      return false;
    }

    this.turn.reflectionIssued = true;
    return true;
  }
}

export function isRepositoryCorrection(prompt: string): boolean {
  const inspected = prompt.slice(0, MAX_INSPECTED_TEXT);
  return (
    CORRECTION_PATTERNS.some((pattern) => pattern.test(inspected)) &&
    REPO_SURFACE_PATTERN.test(inspected)
  );
}

function isReflectionPrompt(prompt: string): boolean {
  return prompt.trimStart().startsWith(REFLECTION_PROMPT_PREFIX);
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;

  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
    .join(",")}}`;
}

interface CommandOperation {
  readonly command: string;
  readonly target: string;
  readonly validationLike: boolean;
}

function normalizeCommandOperation(input: OperationInput): CommandOperation | undefined {
  const command = commandText(input.toolArgs);
  if (!command) return undefined;

  const candidates = [
    ...explicitPathCandidates(input.toolArgs),
    ...shellPathCandidates(command),
  ];
  if (candidates.some(isUrlLike)) return undefined;

  for (const candidate of candidates) {
    const normalized = normalizeRepoPath(candidate, input.workingDirectory);
    if (normalized) {
      return {
        command: normalizeCommand(command),
        target: normalized,
        validationLike: isValidationCommand(command),
      };
    }
  }

  if (candidates.length > 0) return undefined;

  return {
    command: normalizeCommand(command),
    target: ".",
    validationLike: isValidationCommand(command),
  };
}

function commandText(value: unknown): string | undefined {
  if (typeof value === "string") return value.slice(0, MAX_INSPECTED_TEXT);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  for (const [key, item] of Object.entries(value)) {
    if (
      typeof item === "string" &&
      ["command", "script", "code"].includes(key.toLowerCase())
    ) {
      return item.slice(0, MAX_INSPECTED_TEXT);
    }
  }

  return undefined;
}

function explicitPathCandidates(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];

  return Object.entries(value)
    .filter(([key, item]) => PATH_KEYS.has(key.toLowerCase()) && typeof item === "string")
    .map(([, item]) => item as string);
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function isValidationCommand(command: string): boolean {
  const normalized = normalizeCommand(command);
  return (
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|typecheck|check|build)\b/i.test(
      normalized,
    ) ||
    /\b(?:pytest|rspec|cargo\s+(?:test|check)|go\s+test|gradle\w*\s+(?:test|check|build)|mvn\w*\s+(?:test|verify)|make\s+(?:test|check|lint|build)|python3?\s+-m\s+json\.tool)\b/i.test(
      normalized,
    ) ||
    /\b(?:test|check|lint|typecheck|build|validate)\b/i.test(normalized)
  );
}

function isUrlLike(candidate: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate);
}

function shellPathCandidates(value: string): string[] {
  return value
    .slice(0, MAX_INSPECTED_TEXT)
    .split(/\s+/)
    .map((token) => token.replace(/^["'`([{]+|["'`)\]},;:]+$/g, ""))
    .filter(
      (token) =>
        token.startsWith("./") ||
        token.startsWith("../") ||
        token.includes("/") ||
        /^[\w.-]+\.(?:json|ya?ml|toml|md|js|mjs|cjs|ts|tsx|py|rb|rs|go|java|sh)$/.test(
          token,
        ),
    );
}

function normalizeRepoPath(candidate: string, workingDirectory: string): string | undefined {
  if (!candidate || candidate.includes("\0") || isUrlLike(candidate)) return undefined;

  const root = path.resolve(workingDirectory);
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);

  if (!relative) return ".";

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }

  return relative.split(path.sep).join("/");
}
