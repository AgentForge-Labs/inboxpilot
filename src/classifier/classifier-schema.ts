import {
  CLASSIFIER_CATEGORIES,
  CLASSIFIER_CONTRACT_VERSION,
  RECOMMENDED_ACTIONS,
  RETENTION_DISPOSITIONS,
} from "./classifier-contract.js";

export const CLASSIFIER_OUTPUT_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://inboxpilot.local/schemas/classifier-output-v1.json",
  title: "InboxPilot canonical classifier result",
  type: "object",
  additionalProperties: false,
  required: [
    "contractVersion",
    "importanceScore",
    "priority",
    "categories",
    "actionRequired",
    "replyRequired",
    "spamRisk",
    "phishingRisk",
    "confidence",
    "recommendedAction",
    "retention",
    "reason",
  ],
  properties: {
    contractVersion: {
      const: CLASSIFIER_CONTRACT_VERSION,
    },
    importanceScore: {
      type: "integer",
      minimum: 0,
      maximum: 100,
    },
    priority: {
      type: "string",
      enum: [
        "critical",
        "important",
        "normal",
        "low",
        "very_low",
        "disposable",
      ],
    },
    categories: {
      type: "array",
      minItems: 1,
      maxItems: CLASSIFIER_CATEGORIES.length,
      uniqueItems: true,
      items: {
        type: "string",
        enum: [...CLASSIFIER_CATEGORIES],
      },
    },
    actionRequired: {
      type: "boolean",
    },
    replyRequired: {
      type: "boolean",
    },
    spamRisk: {
      type: "integer",
      minimum: 0,
      maximum: 100,
    },
    phishingRisk: {
      type: "integer",
      minimum: 0,
      maximum: 100,
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
    recommendedAction: {
      type: "string",
      enum: [...RECOMMENDED_ACTIONS],
    },
    retention: {
      type: "object",
      additionalProperties: false,
      required: [
        "disposition",
        "protected",
        "protectionReasons",
      ],
      properties: {
        disposition: {
          type: "string",
          enum: [...RETENTION_DISPOSITIONS],
        },
        protected: {
          type: "boolean",
        },
        protectionReasons: {
          type: "array",
          uniqueItems: true,
          items: {
            type: "string",
            minLength: 1,
            maxLength: 200,
          },
        },
        archiveAfterDays: {
          type: "integer",
          minimum: 0,
          maximum: 36500,
        },
        trashAfterDays: {
          type: "integer",
          minimum: 0,
          maximum: 36500,
        },
      },
    },
    reason: {
      type: "string",
      minLength: 1,
      maxLength: 2000,
    },
    modelVersion: {
      type: "string",
      minLength: 1,
      maxLength: 200,
    },
  },
} as const;
