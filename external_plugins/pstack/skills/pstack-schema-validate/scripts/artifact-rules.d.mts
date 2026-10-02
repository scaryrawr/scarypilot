export type ArtifactKind = "snapshot" | "receipt" | "handoff";

export interface ArtifactFinding {
  readonly path: string;
  readonly rule: string;
  readonly message: string;
}

export interface ArtifactValidation {
  readonly schemaVersion: 1;
  readonly ok: boolean;
  readonly findings: readonly ArtifactFinding[];
}

export const ARTIFACT_KINDS: readonly ["snapshot", "receipt", "handoff"];

export function validateArtifact(kind: ArtifactKind, value: unknown): ArtifactValidation;
