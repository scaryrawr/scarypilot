import { Type, type Static } from "@sinclair/typebox";

const nonblank = Type.String({ pattern: "\\S" });

const strict = { additionalProperties: false };

const probability = Type.Number({ minimum: 0, maximum: 1 });

const image = Type.String({
  minLength: 4,
  maxLength: 32 * 1024 * 1024,
  pattern: "^[A-Za-z0-9+/]+={0,2}(?![\\s\\S])",
  description: "Raw base64-encoded image, not a URL or data URL.",
});

const dataImage = Type.String({
  maxLength: 32 * 1024 * 1024,
  pattern: "^data:image/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}(?![\\s\\S])",
  description: "Inline base64 image data URI. Remote image URLs are not accepted.",
});

const json = Type.Recursive((self) => Type.Union([
  Type.Null(),
  Type.Boolean(),
  Type.Number(),
  Type.String(),
  Type.Array(self),
  Type.Record(Type.String(), self),
]), { $id: "DecisionJson" });

export const QuestionSchema = Type.Union([
  Type.Object({
    type: Type.Literal("choice"),
    instructions: nonblank,
    criteria: Type.Record(nonblank, Type.Union([Type.String(), Type.Null()]), {
      minProperties: 1,
      additionalProperties: false,
    }),
  }, strict),
  Type.Object({
    type: Type.Literal("noul"),
    instructions: nonblank,
    criteria: Type.Optional(Type.Object({
      true: Type.Optional(Type.String()),
      false: Type.Optional(Type.String()),
    }, strict)),
  }, strict),
  Type.Object({
    type: Type.Literal("score"),
    instructions: nonblank,
    criteria: Type.Array(Type.String(), { minItems: 1 }),
  }, strict),
]);

export type Question = Static<typeof QuestionSchema>;

export type DecisionBoundary = "native" | "cli";

export const DecisionRequestSchema = Type.Object({
  model: nonblank,
  state: Type.Union([nonblank, Type.Boolean(), Type.Number(), Type.Record(Type.String(), json), Type.Array(json)]),
  images: Type.Optional(Type.Array(dataImage)),
  questions: Type.Record(nonblank, QuestionSchema, {
    minProperties: 1,
    additionalProperties: false,
  }),
  truncate: Type.Optional(Type.Boolean({
    description: "Allow server-side state truncation. Defaults to false so context overflow fails explicitly.",
  })),
}, strict);

export type DecisionRequest = Static<typeof DecisionRequestSchema>;

export const DecisionInputSchema = Type.Object({
  ...DecisionRequestSchema.properties,
  images: Type.Optional(Type.Array(Type.Union([
    image,
    dataImage,
    Type.Object({
      path: Type.String({
        pattern: "\\S",
        description: "Absolute path to a local image file. Requires user confirmation of its resolved path and destination before reading; the path is not sent to oMLX.",
      }),
    }, strict),
  ]), { description: "Images shared by all questions, in array order. The server verifies model vision support." })),
}, strict);

export type DecisionInput = Static<typeof DecisionInputSchema>;

const cliState = Type.Union([Type.String(), Type.Record(Type.String(), json), Type.Array(json)]);

export const CliInputSchema = Type.Object({
  state: Type.Optional(cliState),
  images: Type.Optional(Type.Array(Type.Union([image, dataImage]), { minItems: 1, maxItems: 10 })),
  questions: DecisionRequestSchema.properties.questions,
  truncate: Type.Optional(Type.Boolean()),
}, strict);

export type CliInput = Static<typeof CliInputSchema>;

export const CliDecisionInputSchema = Type.Object({
  ...CliInputSchema.properties,
  model: nonblank,
  state: cliState,
}, strict);

const probabilities = Type.Record(Type.String(), probability);

export const DecisionResponseSchema = Type.Object({
  model: nonblank,
  answers: Type.Record(Type.String(), Type.Union([
    Type.Object({
      type: Type.Literal("choice"),
      choice: Type.String(),
      probabilities,
      confidence: probability,
    }, strict),
    Type.Object({
      type: Type.Literal("noul"),
      noul: probability,
    }, strict),
    Type.Object({
      type: Type.Literal("score"),
      score: Type.Number({ minimum: 0 }),
      legend: Type.Record(Type.String(), Type.String()),
      probabilities,
      confidence: probability,
    }, strict),
  ])),
  usage: Type.Object({
    input_tokens: Type.Integer({ minimum: 0 }),
    output_tokens: Type.Literal(0),
  }, strict),
}, strict);

export type DecisionResponse = Static<typeof DecisionResponseSchema>;

export const CliDecisionResponseSchema = Type.Object({
  ...DecisionResponseSchema.properties,
  error: Type.Optional(Type.Null()),
}, { additionalProperties: true });

export const ModelStatusSchema = Type.Object({
  models: Type.Array(Type.Object({
    id: nonblank,
    model_type: nonblank,
    engine_type: nonblank,
    loaded: Type.Boolean(),
  })),
});

export const CliModelStatusSchema = Type.Object({
  models: Type.Array(Type.Object({
    ...ModelStatusSchema.properties.models.items.properties,
    engine_type: Type.Optional(nonblank),
    loaded: Type.Optional(Type.Boolean()),
    model_alias: Type.Optional(nonblank),
    unavailable_reason: Type.Optional(Type.Union([nonblank, Type.Null()])),
  })),
});

export type InstalledModel = Static<typeof CliModelStatusSchema>["models"][number];

export type DecisionModel = Pick<InstalledModel, "id" | "loaded">;

export const EmptySchema = Type.Object({}, strict);

export const ServerErrorSchema = Type.Object({
  error: Type.Optional(Type.Union([
    Type.String(),
    Type.Object({ message: Type.Optional(Type.String()) }),
    Type.Null(),
  ])),
  detail: Type.Optional(Type.Union([
    Type.String(),
    Type.Array(Type.Union([
      Type.Object({ msg: Type.Optional(Type.Union([Type.String(), Type.Number()])) }),
      Type.Null(),
    ])),
  ])),
});
