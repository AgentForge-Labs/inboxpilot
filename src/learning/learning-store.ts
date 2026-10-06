import type {
  PersonalLearningEvent,
  PersonalLearningStore,
} from "./learning-types.js";

function scopeKey(tenantId: string, accountId: string): string {
  return `${tenantId}\u0000${accountId}`;
}

export class InMemoryPersonalLearningStore
  implements PersonalLearningStore
{
  readonly events = new Map<string, Map<string, PersonalLearningEvent>>();

  async append(event: PersonalLearningEvent): Promise<boolean> {
    const key = scopeKey(event.tenantId, event.accountId);
    let scoped = this.events.get(key);
    if (!scoped) {
      scoped = new Map();
      this.events.set(key, scoped);
    }
    if (scoped.has(event.id)) return false;
    scoped.set(event.id, structuredClone(event));
    return true;
  }

  async list(
    tenantId: string,
    accountId: string,
  ): Promise<PersonalLearningEvent[]> {
    const scoped = this.events.get(scopeKey(tenantId, accountId));
    if (!scoped) return [];
    return [...scoped.values()]
      .map((event) => structuredClone(event))
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }

  async reset(
    tenantId: string,
    accountId: string,
  ): Promise<number> {
    const key = scopeKey(tenantId, accountId);
    const count = this.events.get(key)?.size ?? 0;
    this.events.delete(key);
    return count;
  }
}
