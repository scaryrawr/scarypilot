import { Type, type Static } from "@sinclair/typebox";
import { durationPattern } from "./duration.ts";

const nonblank = Type.String({ pattern: "\\S" });

const strict = { additionalProperties: false };

const probability = Type.Number({ minimum: 0, maximum: 1 });

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
      minProperties: 2,
      maxProperties: 26,
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
    criteria: Type.Array(Type.String(), { minItems: 2, maxItems: 26 }),
  }, strict),
]);

export type Question = Static<typeof QuestionSchema>;

export const DecisionRequestSchema = Type.Object({
  model: nonblank,
  state: Type.Union([nonblank, Type.Record(Type.String(), json), Type.Array(json)]),
  questions: Type.Record(nonblank, QuestionSchema, {
    minProperties: 1,
    maxProperties: 64,
    additionalProperties: false,
  }),
  keep_alive: Type.Optional(Type.Union([Type.String({ pattern: durationPattern }), Type.Number()])),
}, strict);

export type DecisionRequest = Static<typeof DecisionRequestSchema>;

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
      score: Type.Number({ minimum: 0, maximum: 25 }),
      legend: Type.Record(Type.String(), Type.String()),
      probabilities,
      confidence: probability,
    }, strict),
  ])),
  usage: Type.Object({
    input_tokens: Type.Integer({ minimum: 0 }),
    output_tokens: Type.Integer({ minimum: 0 }),
  }, strict),
}, strict);

export type DecisionResponse = Static<typeof DecisionResponseSchema>;

export const TagsSchema = Type.Object({
  models: Type.Array(Type.Object({
    name: nonblank,
    capabilities: Type.Optional(Type.Array(Type.String())),
  })),
});

export type InstalledModel = Static<typeof TagsSchema>["models"][number];

export const ShowSchema = Type.Object({ capabilities: Type.Array(Type.String()) });

export const EmptySchema = Type.Object({}, strict);
