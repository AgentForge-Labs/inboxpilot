import {
  buildImportanceBandEditorViewModel,
  type ImportanceBandEditorViewModel,
  type ThresholdMarkerKind,
  moveImportanceThresholdMarker,
  moveImportanceBandBoundary,
} from "./importance-band-editor.js";
import type {
  ImportanceSettings,
} from "../settings/importance-settings.js";
import type {
  ImportanceSettingsStore,
} from "../settings/importance-settings-store.js";

export class ImportanceSettingsService {
  constructor(private readonly store: ImportanceSettingsStore) {}

  async getEditor(
    tenantId: string,
    accountId: string,
  ): Promise<{
    revision: number;
    editor: ImportanceBandEditorViewModel;
  }> {
    const record = await this.store.get(tenantId, accountId);
    return {
      revision: record.revision,
      editor: buildImportanceBandEditorViewModel(record.settings),
    };
  }

  async updateThreshold(
    tenantId: string,
    accountId: string,
    expectedRevision: number,
    marker: ThresholdMarkerKind,
    value: number,
  ) {
    const current = await this.store.get(tenantId, accountId);
    const nextSettings = moveImportanceThresholdMarker(
      current.settings,
      marker,
      value,
    );
    const record = await this.store.update(
      tenantId,
      accountId,
      expectedRevision,
      {
        bands: nextSettings.bands,
        automation: nextSettings.automation,
      },
    );
    return {
      revision: record.revision,
      editor: buildImportanceBandEditorViewModel(record.settings),
    };
  }

  async updateBandBoundary(
    tenantId: string,
    accountId: string,
    expectedRevision: number,
    boundary: keyof ImportanceSettings["bands"],
    value: number,
  ) {
    const current = await this.store.get(tenantId, accountId);
    const nextSettings = moveImportanceBandBoundary(
      current.settings,
      boundary,
      value,
    );
    const record = await this.store.update(
      tenantId,
      accountId,
      expectedRevision,
      { bands: nextSettings.bands },
    );
    return {
      revision: record.revision,
      editor: buildImportanceBandEditorViewModel(record.settings),
    };
  }

  async reset(
    tenantId: string,
    accountId: string,
    expectedRevision: number,
  ) {
    const record = await this.store.reset(
      tenantId,
      accountId,
      expectedRevision,
    );
    return {
      revision: record.revision,
      editor: buildImportanceBandEditorViewModel(record.settings),
    };
  }
}
