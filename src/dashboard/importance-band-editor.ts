import {
  importanceBandRanges,
  mergeImportanceSettings,
  validateImportanceSettings,
  type ImportanceBandRange,
  type ImportanceSettings,
} from "../settings/importance-settings.js";

export type ThresholdMarkerKind =
  | "important"
  | "archive_below"
  | "auto_delete_below";

export interface ImportanceBandEditorMarker {
  kind: ThresholdMarkerKind;
  value: number;
  positionPercent: number;
  label: string;
}

export interface ImportanceBandEditorSegment extends ImportanceBandRange {
  widthPercent: number;
  startPercent: number;
  endPercent: number;
  label: string;
}

export interface ImportanceBandEditorViewModel {
  min: 0;
  max: 100;
  segments: ImportanceBandEditorSegment[];
  markers: ImportanceBandEditorMarker[];
  settings: ImportanceSettings;
}

const LABELS: Record<ImportanceBandRange["priority"], string> = {
  critical: "Critical",
  important: "Important",
  normal: "Normal",
  low: "Low Priority",
  very_low: "Very Low",
  disposable: "Disposable",
};

function percent(score: number): number {
  return Math.max(0, Math.min(100, score));
}

export function buildImportanceBandEditorViewModel(
  settings: ImportanceSettings,
): ImportanceBandEditorViewModel {
  const valid = validateImportanceSettings(settings);
  const segments = importanceBandRanges(valid).map((range) => ({
    ...range,
    widthPercent:
      (range.max === 100 ? 100 : range.max + 1) - range.min,
    startPercent: percent(range.min),
    endPercent: percent(range.max === 100 ? 100 : range.max + 1),
    label: LABELS[range.priority],
  }));

  return {
    min: 0,
    max: 100,
    segments,
    markers: [
      {
        kind: "auto_delete_below",
        value: valid.automation.autoDeleteBelow,
        positionPercent: percent(valid.automation.autoDeleteBelow),
        label: "Auto-delete below",
      },
      {
        kind: "archive_below",
        value: valid.automation.archiveBelow,
        positionPercent: percent(valid.automation.archiveBelow),
        label: "Archive below",
      },
      {
        kind: "important",
        value: valid.bands.importantAt,
        positionPercent: percent(valid.bands.importantAt),
        label: "Important at or above",
      },
    ],
    settings: valid,
  };
}

export function moveImportanceThresholdMarker(
  settings: ImportanceSettings,
  marker: ThresholdMarkerKind,
  value: number,
): ImportanceSettings {
  if (!Number.isInteger(value)) {
    throw new RangeError("Threshold marker value must be an integer");
  }

  switch (marker) {
    case "important":
      return mergeImportanceSettings(settings, {
        bands: { importantAt: value },
      });
    case "archive_below":
      return mergeImportanceSettings(settings, {
        automation: { archiveBelow: value },
      });
    case "auto_delete_below":
      return mergeImportanceSettings(settings, {
        automation: { autoDeleteBelow: value },
      });
  }
}

export function moveImportanceBandBoundary(
  settings: ImportanceSettings,
  boundary: keyof ImportanceSettings["bands"],
  value: number,
): ImportanceSettings {
  return mergeImportanceSettings(settings, {
    bands: { [boundary]: value },
  });
}
