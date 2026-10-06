import type {
  CanonicalMessage,
  CanonicalThread,
  ProviderKind,
} from "../domain/email-model.js";
import {
  unsupportedCapabilities,
  type MessageMoveTarget,
  type ProviderAdapter,
  type ProviderCapabilityName,
  type ProviderCapabilities,
  type ProviderConnectResult,
  type ProviderConnectionContext,
  type ProviderFolder,
  type ProviderLabel,
  type SyncChangesRequest,
  type SyncChangesResult,
} from "./provider-adapter.js";
import {
  ProviderCapabilityError,
  ProviderNotConnectedError,
} from "./provider-errors.js";

export abstract class BaseProviderAdapter implements ProviderAdapter {
  private connected = false;

  protected constructor(
    readonly kind: ProviderKind,
    private readonly supported: readonly ProviderCapabilityName[],
  ) {}

  capabilities(): ProviderCapabilities {
    return unsupportedCapabilities(this.supported);
  }

  async connect(context: ProviderConnectionContext): Promise<ProviderConnectResult> {
    const result = await this.onConnect(context);
    this.connected = true;
    return result;
  }

  protected abstract onConnect(
    context: ProviderConnectionContext,
  ): Promise<ProviderConnectResult>;

  protected assertConnected(): void {
    if (!this.connected) {
      throw new ProviderNotConnectedError(this.kind);
    }
  }

  protected setDisconnected(): void {
    this.connected = false;
  }

  protected assertCapability(capability: ProviderCapabilityName): void {
    if (!this.capabilities()[capability]) {
      throw new ProviderCapabilityError(this.kind, capability);
    }
  }

  protected unsupported(capability: ProviderCapabilityName): never {
    throw new ProviderCapabilityError(this.kind, capability);
  }

  async listFolders(): Promise<ProviderFolder[]> {
    this.assertConnected();
    this.assertCapability("listFolders");
    return this.unsupported("listFolders");
  }

  async listLabels(): Promise<ProviderLabel[]> {
    this.assertConnected();
    this.assertCapability("listLabels");
    return this.unsupported("listLabels");
  }

  async syncChanges(_request?: SyncChangesRequest): Promise<SyncChangesResult> {
    this.assertConnected();
    this.assertCapability("syncChanges");
    return this.unsupported("syncChanges");
  }

  async getMessage(_providerMessageId: string): Promise<CanonicalMessage> {
    this.assertConnected();
    this.assertCapability("getMessage");
    return this.unsupported("getMessage");
  }

  async getThread(_providerThreadId: string): Promise<CanonicalThread> {
    this.assertConnected();
    this.assertCapability("getThread");
    return this.unsupported("getThread");
  }

  async archive(_providerMessageId: string): Promise<void> {
    this.assertConnected();
    this.assertCapability("archive");
    return this.unsupported("archive");
  }

  async move(
    _providerMessageId: string,
    _target: MessageMoveTarget,
  ): Promise<void> {
    this.assertConnected();
    this.assertCapability("move");
    return this.unsupported("move");
  }

  async trash(_providerMessageId: string): Promise<void> {
    this.assertConnected();
    this.assertCapability("trash");
    return this.unsupported("trash");
  }

  async restore(_providerMessageId: string): Promise<void> {
    this.assertConnected();
    this.assertCapability("restore");
    return this.unsupported("restore");
  }

  async deletePermanent(_providerMessageId: string): Promise<void> {
    this.assertConnected();
    this.assertCapability("deletePermanent");
    return this.unsupported("deletePermanent");
  }

  async addLabel(_providerMessageId: string, _labelId: string): Promise<void> {
    this.assertConnected();
    this.assertCapability("addLabel");
    return this.unsupported("addLabel");
  }

  async removeLabel(
    _providerMessageId: string,
    _labelId: string,
  ): Promise<void> {
    this.assertConnected();
    this.assertCapability("removeLabel");
    return this.unsupported("removeLabel");
  }

  async markImportant(
    _providerMessageId: string,
    _important = true,
  ): Promise<void> {
    this.assertConnected();
    this.assertCapability("markImportant");
    return this.unsupported("markImportant");
  }

  async star(_providerMessageId: string, _starred = true): Promise<void> {
    this.assertConnected();
    this.assertCapability("star");
    return this.unsupported("star");
  }

  async markRead(_providerMessageId: string, _read = true): Promise<void> {
    this.assertConnected();
    this.assertCapability("markRead");
    return this.unsupported("markRead");
  }
}
