import type { Tool } from "@github/copilot-sdk";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { open } from "node:fs/promises";
import type { CwdRef } from "../extension-context.ts";
import { readWorkspaceFile } from "../workspace-reader.ts";
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
      const raw = file.bytes.toString("utf8");

      if (args.kind === "plan") {
        const profile = args.profile ?? "verified-stack";
        const result = validatePlanText(raw, profile);

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
        ...validateArtifact(args.kind, JSON.parse(raw)),
      });
    },
  };
}
