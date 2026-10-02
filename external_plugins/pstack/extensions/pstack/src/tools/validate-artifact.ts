import type { Tool } from "@github/copilot-sdk";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { CwdRef } from "../extension-context.ts";
import { json } from "./common.ts";
import {
  ARTIFACT_KINDS, validateArtifact, type ArtifactKind, type ArtifactValidation,
} from "../../../../skills/pstack-schema-validate/scripts/artifact-rules.mjs";
import {
  PLAN_PROFILES, validatePlanText, type PlanValidation,
} from "../../../../skills/poteto-mode/scripts/plan-rules.mjs";

const PathSchema = Type.String({ minLength: 1 });

const ProfileSchema = Type.Union(PLAN_PROFILES.map((profile) => Type.Literal(profile)));

export const ValidateArtifactParametersSchema = Type.Object({
  kind: Type.Union([...ARTIFACT_KINDS, "plan"].map((kind) => Type.Literal(kind))),
  path: PathSchema,
  profile: Type.Optional(ProfileSchema),
}, { additionalProperties: false });

export const ValidateArtifactInputSchema = Type.Union([
  ...ARTIFACT_KINDS.map((kind) =>
    Type.Object({ kind: Type.Literal(kind), path: PathSchema }, { additionalProperties: false }),
  ),
  Type.Object({
    kind: Type.Literal("plan"),
    path: PathSchema,
    profile: Type.Optional(ProfileSchema),
  }, { additionalProperties: false }),
]);

export type ValidateArtifactInput = Static<typeof ValidateArtifactInputSchema>;

export interface JsonArtifactOutput extends ArtifactValidation {
  readonly kind: ArtifactKind;
  readonly path: string;
}

export interface PlanArtifactOutput extends Omit<PlanValidation, "profile"> {
  readonly kind: "plan";
  readonly path: string;
  readonly profile: (typeof PLAN_PROFILES)[number];
  readonly ok: boolean;
}

export type ValidateArtifactOutput = JsonArtifactOutput | PlanArtifactOutput;

function inside(root: string, path: string): boolean {
  const child = relative(root, path);

  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function openConfinedFile(path: string, openFile: typeof open) {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

  if (process.platform === "darwin") {
    // Darwin's O_NOFOLLOW_ANY rejects symlinks in every component; Node exposes only O_NOFOLLOW.
    const noFollowAny = 0x20000000;

    return openFile(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollowAny);
  }

  if (process.platform !== "linux") {
    throw new Error("native workspace-confined validation requires macOS or Linux; use the approved-workspace CLI fallback on other platforms");
  }

  const directoryFlags = flags | constants.O_DIRECTORY;
  let parent = await openFile("/", directoryFlags);

  try {
    for (const directory of dirname(path).split(sep).filter(Boolean)) {
      const previous = parent;
      parent = await openFile(`/proc/self/fd/${parent.fd}/${directory}`, directoryFlags);
      await previous.close();
    }

    return await openFile(`/proc/self/fd/${parent.fd}/${basename(path)}`, flags);
  } finally {
    await parent.close();
  }
}

async function readWorkspaceFile(cwd: string, path: string, openFile: typeof open): Promise<{ path: string; raw: string }> {
  if (
    !path.trim() || path.includes("\0") ||
    /^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith("//") ||
    path.split(/[\\/]/).includes("..")
  ) {
    throw new Error("path must name one workspace file, without URLs or traversal");
  }

  const root = await realpath(cwd);
  const target = resolve(cwd, path);

  if (!inside(resolve(cwd), target) && !inside(root, target)) {
    throw new Error("path must stay inside the current workspace");
  }

  const resolved = await realpath(target);

  if (!inside(root, resolved)) throw new Error("path resolves outside the current workspace");
  const file = await openConfinedFile(resolved, openFile);

  try {
    if (!(await file.stat()).isFile()) throw new Error("path must name a regular file");

    return { path: resolved, raw: await file.readFile("utf8") };
  } finally {
    await file.close();
  }
}

export function createValidateArtifactTool(cwdRef: CwdRef, openFile: typeof open = open): Tool<ValidateArtifactInput> & {
  handler: NonNullable<Tool<ValidateArtifactInput>["handler"]>;
} {
  return {
    name: "pstack_validate_artifact",
    description:
      "Read and validate exactly one snapshot, receipt, handoff, or Markdown plan inside the current workspace. Does not read referenced files, collect status, run commands, or write. Only plans accept a profile, default verified-stack.",
    parameters: ValidateArtifactParametersSchema,
    handler: async (args) => {
      if (!Value.Check(ValidateArtifactInputSchema, args)) {
        throw new Error("invalid artifact arguments; use {kind, path}, or {kind: 'plan', path, profile?: 'basic' | 'verified-stack'}");
      }

      const file = await readWorkspaceFile(cwdRef.get(), args.path, openFile);

      if (args.kind === "plan") {
        const profile = args.profile ?? "verified-stack";
        const result = validatePlanText(file.raw, profile);

        return json<ValidateArtifactOutput>({
          kind: args.kind,
          path: file.path,
          profile,
          ok: result.findings.length === 0,
          findings: result.findings,
          report: result.report,
        });
      }

      return json<ValidateArtifactOutput>({
        kind: args.kind,
        path: file.path,
        ...validateArtifact(args.kind, JSON.parse(file.raw)),
      });
    },
  };
}
