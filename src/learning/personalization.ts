import {
  priorityForImportanceScore,
} from "../classifier/classifier-contract.js";
import type {
  DeterministicImportanceResult,
} from "../classifier/importance-engine.js";
import type {
  PersonalLearningEvaluation,
} from "./learning-types.js";

export interface PersonalizedImportanceResult {
  base: DeterministicImportanceResult;
  personal: PersonalLearningEvaluation;
  importanceScore: number;
  priority: ReturnType<typeof priorityForImportanceScore>;
  recommendedHandling:
    | "keep"
    | "archive"
    | "protect"
    | "avoid_archive"
    | "avoid_trash";
  reasons: string[];
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function applyPersonalLearning(
  base: DeterministicImportanceResult,
  personal: PersonalLearningEvaluation,
): PersonalizedImportanceResult {
  const importanceScore = clampScore(
    base.importanceScore + personal.importanceDelta,
  );

  let recommendedHandling:
    PersonalizedImportanceResult["recommendedHandling"] = "keep";

  if (personal.neverDelete) {
    recommendedHandling = "protect";
  } else if (personal.avoidTrash) {
    recommendedHandling = "avoid_trash";
  } else if (personal.avoidArchive) {
    recommendedHandling = "avoid_archive";
  } else if (personal.alwaysArchive) {
    recommendedHandling = "archive";
  }

  return {
    base,
    personal,
    importanceScore,
    priority: priorityForImportanceScore(importanceScore),
    recommendedHandling,
    reasons: [...personal.reasons],
  };
}
