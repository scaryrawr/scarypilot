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
];

const REPO_SURFACE_PATTERN =
  /\b(?:repo(?:sitory)?|agents?\.md|claude\.md|(?:codex|copilot) instructions?|skill\.md|readme(?:\.md)?|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|cargo\.toml|go\.mod|manifest|config(?:uration)? file|setup instructions?|install(?:ation)? instructions?|workflow file|project convention|npm|pnpm|yarn|bun|gradle|maven|cargo|pytest|rspec)\b/i;

const USAGE_ERROR_PATTERN =
  /\b(?:unknown|unrecognized|invalid|unsupported|unexpected)\s+(?:option|argument|flag|command)|\busage:|\bno such (?:script|command)\b|\bmissing required (?:argument|option)\b/i;


export function isRepositoryCorrection(prompt) {
  const text = prompt.slice(0, 8192);

  return CORRECTION_PATTERNS.some((pattern) => pattern.test(text)) && REPO_SURFACE_PATTERN.test(text);
}

export function isUsageError(text) { return USAGE_ERROR_PATTERN.test(text.slice(0, 8192)); }
