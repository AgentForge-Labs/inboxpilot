import {
  parsePrivacyCloudEnvelope,
} from "./privacy-envelope.js";
import type {
  PrivacyCloudClassificationEnvelope,
  PrivacyModeCloudStore,
} from "./privacy-mode-types.js";

function key(
  tenantId: string,
  accountId: string,
  cloudMessageId: string,
): string {
  return [tenantId, accountId, cloudMessageId].join(
    "\u0000",
  );
}

export class InMemoryPrivacyModeCloudStore
  implements PrivacyModeCloudStore
{
  private readonly records = new Map<
    string,
    PrivacyCloudClassificationEnvelope
  >();

  async put(
    envelope: PrivacyCloudClassificationEnvelope,
  ): Promise<void> {
    const parsed = parsePrivacyCloudEnvelope(envelope);
    this.records.set(
      key(
        parsed.tenantId,
        parsed.accountId,
        parsed.cloudMessageId,
      ),
      structuredClone(parsed),
    );
  }

  async ingestUnknown(value: unknown): Promise<void> {
    const parsed = parsePrivacyCloudEnvelope(value);
    await this.put(parsed);
  }

  async get(
    tenantId: string,
    accountId: string,
    cloudMessageId: string,
  ): Promise<
    PrivacyCloudClassificationEnvelope | undefined
  > {
    const value = this.records.get(
      key(tenantId, accountId, cloudMessageId),
    );
    return value ? structuredClone(value) : undefined;
  }

  async listForAccount(
    tenantId: string,
    accountId: string,
  ): Promise<PrivacyCloudClassificationEnvelope[]> {
    return [...this.records.values()]
      .filter(
        (record) =>
          record.tenantId === tenantId &&
          record.accountId === accountId,
      )
      .sort((a, b) =>
        b.receivedAt.localeCompare(a.receivedAt),
      )
      .map((record) => structuredClone(record));
  }
}
