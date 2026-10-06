import type { PriorityBand } from "../domain/email-model.js";

export interface ImportanceBandBoundaries {
  criticalAt: number;
  importantAt: number;
  normalAt: number;
  lowAt: number;
  veryLowAt: number;
}

export interface AutomationThresholdSettings {
  archiveBelow: number;
  autoDeleteBelow: number;
  minClassifierConfidence: number;
}

export interface ImportanceSettings {
  version: 1;
  bands: ImportanceBandBoundaries;
  automation: AutomationThresholdSettings;
}

export interface ImportanceBandRange {
  priority: PriorityBand;
  min: number;
  max: number;
}

export const DEFAULT_IMPORTANCE_SETTINGS: Readonly<ImportanceSettings> =
  Object.freeze({
    version: 1,
    bands: Object.freeze({
      criticalAt: 90,
      importantAt: 75,
      normalAt: 50,
      lowAt: 30,
      veryLowAt: 10,
    }),
    automation: Object.freeze({
      archiveBelow: 45,
      autoDeleteBelow: 20,
      minClassifierConfidence: 0.8,
    }),
  });

function score(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 100
  ) {
    throw new RangeError(field + " must be an integer between 0 and 100");
  }
  return value;
}

export function validateImportanceSettings(
  input: ImportanceSettings,
): ImportanceSettings {
  if (input.version !== 1) {
    throw new TypeError("Unsupported importance-settings version");
  }

  const criticalAt = score(input.bands.criticalAt, "bands.criticalAt");
  const importantAt = score(input.bands.importantAt, "bands.importantAt");
  const normalAt = score(input.bands.normalAt, "bands.normalAt");
  const lowAt = score(input.bands.lowAt, "bands.lowAt");
  const veryLowAt = score(input.bands.veryLowAt, "bands.veryLowAt");

  if (!(criticalAt > importantAt &&
        importantAt > normalAt &&
        normalAt > lowAt &&
        lowAt > veryLowAt &&
        veryLowAt > 0)) {
    throw new RangeError(
      "Importance bands must be strictly ordered: critical > important > normal > low > veryLow > 0",
    );
  }

  const archiveBelow = score(
    input.automation.archiveBelow,
    "automation.archiveBelow",
  );
  const autoDeleteBelow = score(
    input.automation.autoDeleteBelow,
    "automation.autoDeleteBelow",
  );

  if (autoDeleteBelow > archiveBelow) {
    throw new RangeError("autoDeleteBelow must be <= archiveBelow");
  }
  if (archiveBelow >= importantAt) {
    throw new RangeError(
      "archiveBelow must be lower than bands.importantAt",
    );
  }

  const confidence = input.automation.minClassifierConfidence;
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new RangeError(
      "automation.minClassifierConfidence must be between 0 and 1",
    );
  }

  return {
    version: 1,
    bands: { criticalAt, importantAt, normalAt, lowAt, veryLowAt },
    automation: {
      archiveBelow,
      autoDeleteBelow,
      minClassifierConfidence: confidence,
    },
  };
}

export function priorityForScoreWithSettings(
  value: number,
  settings: ImportanceSettings = DEFAULT_IMPORTANCE_SETTINGS,
): PriorityBand {
  score(value, "importanceScore");
  const valid = validateImportanceSettings(settings);
  if (value >= valid.bands.criticalAt) return "critical";
  if (value >= valid.bands.importantAt) return "important";
  if (value >= valid.bands.normalAt) return "normal";
  if (value >= valid.bands.lowAt) return "low";
  if (value >= valid.bands.veryLowAt) return "very_low";
  return "disposable";
}

export function importanceBandRanges(
  settings: ImportanceSettings = DEFAULT_IMPORTANCE_SETTINGS,
): ImportanceBandRange[] {
  const valid = validateImportanceSettings(settings);
  return [
    { priority: "disposable", min: 0, max: valid.bands.veryLowAt - 1 },
    { priority: "very_low", min: valid.bands.veryLowAt, max: valid.bands.lowAt - 1 },
    { priority: "low", min: valid.bands.lowAt, max: valid.bands.normalAt - 1 },
    { priority: "normal", min: valid.bands.normalAt, max: valid.bands.importantAt - 1 },
    { priority: "important", min: valid.bands.importantAt, max: valid.bands.criticalAt - 1 },
    { priority: "critical", min: valid.bands.criticalAt, max: 100 },
  ];
}

export function mergeImportanceSettings(
  current: ImportanceSettings,
  patch: {
    bands?: Partial<ImportanceBandBoundaries>;
    automation?: Partial<AutomationThresholdSettings>;
  },
): ImportanceSettings {
  return validateImportanceSettings({
    version: 1,
    bands: { ...current.bands, ...patch.bands },
    automation: { ...current.automation, ...patch.automation },
  });
}

export interface PolicyThresholdProjection {
  importantAtOrAbove: number;
  archiveBelow: number;
  trashBelow: number;
  minClassifierConfidence: number;
}

export function policyThresholdsFromImportanceSettings(
  settings: ImportanceSettings,
): PolicyThresholdProjection {
  const valid = validateImportanceSettings(settings);
  return {
    importantAtOrAbove: valid.bands.importantAt,
    archiveBelow: valid.automation.archiveBelow,
    trashBelow: valid.automation.autoDeleteBelow,
    minClassifierConfidence:
      valid.automation.minClassifierConfidence,
  };
}
