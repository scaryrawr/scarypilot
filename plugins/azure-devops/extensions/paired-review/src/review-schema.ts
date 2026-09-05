import { Type, type Static } from "@sinclair/typebox";

export const DiffSideSchema = Type.Union([
  Type.Literal("additions"),
  Type.Literal("deletions"),
]);
export type DiffSide = Static<typeof DiffSideSchema>;

export const LineRangeSchema = Type.Object({
  start: Type.Integer({ minimum: 1 }),
  end: Type.Integer({ minimum: 1 }),
});

export const ChangedLineRangesSchema = Type.Object({
  additions: Type.Array(LineRangeSchema),
  deletions: Type.Array(LineRangeSchema),
});

export const ReviewFileSchema = Type.Object({
  path: Type.String(),
  previousPath: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  additions: Type.Optional(Type.Number()),
  deletions: Type.Optional(Type.Number()),
  diff: Type.String(),
  oldContent: Type.Optional(Type.String()),
  newContent: Type.Optional(Type.String()),
  changedLineRanges: Type.Optional(ChangedLineRangesSchema),
  changeTrackingId: Type.Optional(Type.Number()),
  iterationId: Type.Optional(Type.Number()),
});
export type ReviewFile = Static<typeof ReviewFileSchema>;

export const ReviewThreadMessageSchema = Type.Object({
  id: Type.String(),
  role: Type.Union([
    Type.Literal("user"),
    Type.Literal("assistant"),
    Type.Literal("reviewer"),
  ]),
  author: Type.Optional(Type.String()),
  body: Type.String(),
  createdAt: Type.String(),
});
export type ReviewThreadMessage = Static<typeof ReviewThreadMessageSchema>;

export const LineAnchorSchema = Type.Object({
  path: Type.String(),
  side: DiffSideSchema,
  lineStart: Type.Integer({ minimum: 1 }),
  lineEnd: Type.Integer({ minimum: 1 }),
  sourceDigest: Type.Optional(Type.String()),
});
export type LineAnchor = Static<typeof LineAnchorSchema>;

const ThreadStateSchema = {
  id: Type.String(),
  anchor: LineAnchorSchema,
  pending: Type.Boolean(),
  fixing: Type.Boolean(),
  collapsed: Type.Boolean(),
  resolved: Type.Boolean(),
  messages: Type.Array(ReviewThreadMessageSchema, { minItems: 1 }),
};

export const ReviewThreadSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("question"),
    ...ThreadStateSchema,
  }),
  Type.Object({
    kind: Type.Literal("finding"),
    ...ThreadStateSchema,
    finding: Type.Object({
      id: Type.String(),
      severity: Type.Union([
        Type.Literal("info"),
        Type.Literal("warning"),
        Type.Literal("blocking"),
      ]),
      title: Type.String(),
      body: Type.String(),
      createdByPass: Type.String(),
      publication: Type.Union([
        Type.Object({ kind: Type.Literal("local") }),
        Type.Object({
          kind: Type.Literal("linked"),
          remoteThreadId: Type.Integer({ minimum: 1 }),
          disposition: Type.Union([Type.Literal("published"), Type.Literal("duplicate")]),
        }),
      ]),
    }),
  }),
  Type.Object({
    kind: Type.Literal("remote"),
    ...ThreadStateSchema,
    remoteThreadId: Type.Integer({ minimum: 1 }),
  }),
]);
export type ReviewThread = Static<typeof ReviewThreadSchema>;

export const ReviewPassSchema = Type.Union([
  Type.Object({ kind: Type.Literal("idle") }),
  Type.Object({
    kind: Type.Literal("queued"),
    id: Type.String(),
    requestId: Type.String(),
  }),
  Type.Object({
    kind: Type.Literal("running"),
    id: Type.String(),
    requestId: Type.String(),
    findingCount: Type.Integer({ minimum: 0 }),
  }),
  Type.Object({
    kind: Type.Literal("completed"),
    id: Type.String(),
    requestId: Type.String(),
    findingCount: Type.Integer({ minimum: 0 }),
  }),
  Type.Object({
    kind: Type.Literal("failed"),
    id: Type.String(),
    requestId: Type.String(),
    findingCount: Type.Integer({ minimum: 0 }),
    error: Type.String(),
  }),
]);
export type ReviewPass = Static<typeof ReviewPassSchema>;

export const CreateReviewThreadInputSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  side: DiffSideSchema,
  lineStart: Type.Integer({ minimum: 1 }),
  lineEnd: Type.Integer({ minimum: 1 }),
  body: Type.String({ minLength: 1, maxLength: 8000 }),
});
export type CreateReviewThreadInput = Static<typeof CreateReviewThreadInputSchema>;

export const CreateReviewFindingInputSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  side: DiffSideSchema,
  lineStart: Type.Integer({ minimum: 1 }),
  lineEnd: Type.Integer({ minimum: 1 }),
  severity: Type.Union([
    Type.Literal("info"),
    Type.Literal("warning"),
    Type.Literal("blocking"),
  ]),
  title: Type.String({ minLength: 1, maxLength: 500 }),
  body: Type.String({ minLength: 1, maxLength: 8000 }),
});
export type CreateReviewFindingInput = Static<typeof CreateReviewFindingInputSchema>;

export const PublishReviewFindingsInputSchema = Type.Object({
  selection: Type.Union([
    Type.Object({
      kind: Type.Literal("finding_ids"),
      findingIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    }),
    Type.Object({ kind: Type.Literal("all_open") }),
  ]),
});
export type PublishReviewFindingsInput = Static<typeof PublishReviewFindingsInputSchema>;

export const StartReviewPassInputSchema = Type.Object({
  requestId: Type.String({ minLength: 1, maxLength: 200 }),
});
export type StartReviewPassInput = Static<typeof StartReviewPassInputSchema>;

export const ReplyToReviewThreadInputSchema = Type.Object({
  body: Type.String({ minLength: 1, maxLength: 8000 }),
});

export const FixReviewThreadInputSchema = Type.Object({});

export const UpdateReviewThreadInputSchema = Type.Object({
  collapsed: Type.Optional(Type.Boolean()),
  resolved: Type.Optional(Type.Boolean()),
});
export type UpdateReviewThreadInput = Static<typeof UpdateReviewThreadInputSchema>;

export const FocusReviewFileInputSchema = Type.Object({
  activePath: Type.String(),
});

export const GetThreadContextInputSchema = Type.Object({
  threadId: Type.String({ minLength: 1 }),
  contextLines: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
});

export const GetReviewFileLinesInputSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  side: DiffSideSchema,
  startLine: Type.Integer({ minimum: 1 }),
  endLine: Type.Integer({ minimum: 1 }),
});

export const ListReviewFilesInputSchema = Type.Object({
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export const ReviewStateSchema = Type.Object({
  instanceId: Type.String(),
  prUrl: Type.String(),
  title: Type.String(),
  status: Type.String(),
  loaded: Type.Boolean(),
  sourceBranch: Type.Optional(Type.String()),
  targetBranch: Type.Optional(Type.String()),
  activePath: Type.Optional(Type.String()),
  files: Type.Array(ReviewFileSchema),
  reviewPass: ReviewPassSchema,
  threads: Type.Array(ReviewThreadSchema),
  updatedAt: Type.String(),
});
export type ReviewState = Static<typeof ReviewStateSchema>;
