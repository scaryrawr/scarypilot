import { Type, type Static } from "@sinclair/typebox";

export const ReviewFileSchema = Type.Object({
  path: Type.String(),
  previousPath: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  additions: Type.Optional(Type.Number()),
  deletions: Type.Optional(Type.Number()),
  diff: Type.String(),
  oldContent: Type.Optional(Type.String()),
  newContent: Type.Optional(Type.String()),
});

export type ReviewFile = Static<typeof ReviewFileSchema>;

export const ReviewFindingSchema = Type.Object({
  path: Type.String(),
  line: Type.Optional(Type.Number()),
  severity: Type.Optional(Type.String()),
  title: Type.String(),
  body: Type.Optional(Type.String()),
});

export type ReviewFinding = Static<typeof ReviewFindingSchema>;

export const ReviewThreadMessageSchema = Type.Object({
  id: Type.String(),
  role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
  body: Type.String(),
  createdAt: Type.String(),
});

export type ReviewThreadMessage = Static<typeof ReviewThreadMessageSchema>;

export const ReviewThreadSchema = Type.Object({
  id: Type.String(),
  path: Type.String(),
  side: Type.Union([Type.Literal("additions"), Type.Literal("deletions")]),
  lineStart: Type.Number(),
  lineEnd: Type.Number(),
  pending: Type.Boolean(),
  collapsed: Type.Boolean(),
  resolved: Type.Boolean(),
  messages: Type.Array(ReviewThreadMessageSchema),
});

export type ReviewThread = Static<typeof ReviewThreadSchema>;

export const CreateReviewThreadInputSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  side: Type.Union([Type.Literal("additions"), Type.Literal("deletions")]),
  lineStart: Type.Integer({ minimum: 1 }),
  lineEnd: Type.Integer({ minimum: 1 }),
  body: Type.String({ minLength: 1, maxLength: 8000 }),
});

export type CreateReviewThreadInput = Static<typeof CreateReviewThreadInputSchema>;

export const ReplyToReviewThreadInputSchema = Type.Object({
  body: Type.String({ minLength: 1, maxLength: 8000 }),
});

export const UpdateReviewThreadInputSchema = Type.Object({
  collapsed: Type.Optional(Type.Boolean()),
  resolved: Type.Optional(Type.Boolean()),
});

export type UpdateReviewThreadInput = Static<typeof UpdateReviewThreadInputSchema>;

export const FocusReviewFileInputSchema = Type.Object({
  activePath: Type.String(),
});

export const ReviewStateSchema = Type.Object({
  instanceId: Type.String(),
  prUrl: Type.String(),
  title: Type.String(),
  status: Type.String(),
  sourceBranch: Type.Optional(Type.String()),
  targetBranch: Type.Optional(Type.String()),
  activePath: Type.Optional(Type.String()),
  files: Type.Array(ReviewFileSchema),
  findings: Type.Array(ReviewFindingSchema),
  threads: Type.Array(ReviewThreadSchema),
  updatedAt: Type.String(),
});

export type ReviewState = Static<typeof ReviewStateSchema>;
