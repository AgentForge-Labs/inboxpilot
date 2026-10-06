import type { CanonicalMessage } from "../domain/email-model.js";
import type {
  LearningEventInput,
  PersonalLearningEvaluation,
  PersonalLearningEvent,
  PersonalLearningExport,
  PersonalLearningProfile,
  PersonalLearningStore,
  PersonalPreferenceFeature,
} from "./learning-types.js";
import { PERSONAL_LEARNING_VERSION } from "./learning-types.js";

interface Aggregate {
  score: number;
  count: number;
  updatedAt: string;
}

function normalizeAddress(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function domainFromAddress(value: string | undefined): string | undefined {
  const address = normalizeAddress(value);
  if (!address) return undefined;
  const at = address.lastIndexOf("@");
  if (at <= 0 || at >= address.length - 1) return undefined;
  return address.slice(at + 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function confidenceFromEvidence(
  count: number,
  explicit: boolean,
): number {
  if (explicit) return 1;
  return Math.round(
    clamp(0.35 + Math.min(count, 8) * 0.08, 0, 0.95) * 100,
  ) / 100;
}

function featureKey(
  kind: PersonalPreferenceFeature["kind"],
  scope: PersonalPreferenceFeature["scope"],
  key: string,
): string {
  return `${kind}\u0000${scope}\u0000${key}`;
}

function addAggregate(
  map: Map<string, Aggregate>,
  key: string,
  delta: number,
  occurredAt: string,
): void {
  const current = map.get(key);
  map.set(key, {
    score: (current?.score ?? 0) + delta,
    count: (current?.count ?? 0) + 1,
    updatedAt:
      !current || occurredAt > current.updatedAt
        ? occurredAt
        : current.updatedAt,
  });
}

function subjectForMessage(message: CanonicalMessage) {
  const sender = normalizeAddress(message.from?.address);
  const domain = domainFromAddress(sender);
  return {
    ...(sender ? { sender } : {}),
    ...(domain ? { domain } : {}),
    threadId: message.threadId,
    ...(message.classification.categories.length
      ? { categories: [...message.classification.categories] }
      : {}),
  };
}

export function learningEventFromMessage(
  input: LearningEventInput,
): PersonalLearningEvent {
  if (!input.id.trim()) throw new TypeError("learning event id is required");
  if (Number.isNaN(Date.parse(input.occurredAt ?? new Date().toISOString()))) {
    throw new TypeError("learning event occurredAt is invalid");
  }
  return {
    version: PERSONAL_LEARNING_VERSION,
    id: input.id,
    tenantId: input.message.tenantId,
    accountId: input.message.accountId,
    type: input.type,
    source: input.source,
    subject: subjectForMessage(input.message),
    occurredAt: new Date(
      input.occurredAt ?? new Date().toISOString(),
    ).toISOString(),
  };
}

function compileFeatures(
  events: readonly PersonalLearningEvent[],
): PersonalPreferenceFeature[] {
  const aggregate = new Map<string, Aggregate>();
  const explicit = new Map<string, PersonalPreferenceFeature>();

  for (const event of events) {
    const sender = normalizeAddress(event.subject.sender);
    const domain = normalizeAddress(event.subject.domain);
    const thread = event.subject.threadId?.trim();

    if (event.type === "always_archive_sender" && sender) {
      explicit.set(featureKey("always_archive", "sender", sender), {
        kind: "always_archive",
        scope: "sender",
        key: sender,
        confidence: 1,
        evidenceCount: 1,
        explicit: true,
        reason: "User explicitly said to always archive this sender",
        updatedAt: event.occurredAt,
      });
      continue;
    }

    if (event.type === "never_delete_domain" && domain) {
      explicit.set(featureKey("never_delete", "domain", domain), {
        kind: "never_delete",
        scope: "domain",
        key: domain,
        confidence: 1,
        evidenceCount: 1,
        explicit: true,
        reason: "User explicitly said to never delete this domain",
        updatedAt: event.occurredAt,
      });
      continue;
    }

    const importanceDeltaByType: Partial<Record<
      PersonalLearningEvent["type"],
      number
    >> = {
      explicit_important: 18,
      explicit_not_important: -18,
      manual_mark_important: 10,
      manual_mark_not_important: -10,
      manual_archive: -4,
      manual_keep_in_inbox: 5,
      manual_trash: -7,
      restore_from_archive: 9,
      restore_from_trash: 14,
      user_replied: 7,
    };
    const delta = importanceDeltaByType[event.type];

    if (delta !== undefined && sender) {
      addAggregate(
        aggregate,
        featureKey("importance_adjustment", "sender", sender),
        delta,
        event.occurredAt,
      );
    }
    if (
      delta !== undefined &&
      domain &&
      event.type !== "manual_trash"
    ) {
      addAggregate(
        aggregate,
        featureKey("importance_adjustment", "domain", domain),
        Math.sign(delta) * Math.max(1, Math.round(Math.abs(delta) / 3)),
        event.occurredAt,
      );
    }

    if (event.type === "user_replied") {
      if (sender) {
        addAggregate(
          aggregate,
          featureKey("reply_affinity", "sender", sender),
          1,
          event.occurredAt,
        );
      }
      if (thread) {
        addAggregate(
          aggregate,
          featureKey("reply_affinity", "thread", thread),
          1,
          event.occurredAt,
        );
      }
    }

    if (event.type === "restore_from_archive" && sender) {
      addAggregate(
        aggregate,
        featureKey("avoid_archive", "sender", sender),
        1,
        event.occurredAt,
      );
    }
    if (event.type === "restore_from_trash" && sender) {
      addAggregate(
        aggregate,
        featureKey("avoid_trash", "sender", sender),
        1,
        event.occurredAt,
      );
    }
  }

  const features = [...explicit.values()];

  for (const [key, value] of aggregate) {
    const [kind, scope, featureValue] = key.split("\u0000") as [
      PersonalPreferenceFeature["kind"],
      PersonalPreferenceFeature["scope"],
      string,
    ];

    if (kind === "importance_adjustment") {
      const boundedDelta = clamp(value.score, -30, 30);
      if (Math.abs(boundedDelta) < 4) continue;
      features.push({
        kind,
        scope,
        key: featureValue,
        confidence: confidenceFromEvidence(value.count, false),
        evidenceCount: value.count,
        explicit: false,
        importanceDelta: boundedDelta,
        reason: `Learned from ${value.count} user interaction(s)`,
        updatedAt: value.updatedAt,
      });
      continue;
    }

    if (kind === "reply_affinity") {
      if (value.count < 2) continue;
      features.push({
        kind,
        scope,
        key: featureValue,
        confidence: confidenceFromEvidence(value.count, false),
        evidenceCount: value.count,
        explicit: false,
        reason: `User repeatedly replied to this ${scope}`,
        updatedAt: value.updatedAt,
      });
      continue;
    }

    if (kind === "avoid_archive" || kind === "avoid_trash") {
      if (value.count < 2) continue;
      features.push({
        kind,
        scope,
        key: featureValue,
        confidence: confidenceFromEvidence(value.count, false),
        evidenceCount: value.count,
        explicit: false,
        reason:
          kind === "avoid_archive"
            ? "User repeatedly restored archived mail from this sender"
            : "User repeatedly restored trashed mail from this sender",
        updatedAt: value.updatedAt,
      });
    }
  }

  return features.sort((a, b) =>
    [a.kind, a.scope, a.key].join(":").localeCompare(
      [b.kind, b.scope, b.key].join(":"),
    ),
  );
}

export class PersonalLearningEngine {
  constructor(private readonly store: PersonalLearningStore) {}

  async record(input: LearningEventInput): Promise<boolean> {
    return this.store.append(learningEventFromMessage(input));
  }

  async profile(
    tenantId: string,
    accountId: string,
  ): Promise<PersonalLearningProfile> {
    const events = await this.store.list(tenantId, accountId);
    return {
      version: PERSONAL_LEARNING_VERSION,
      tenantId,
      accountId,
      features: compileFeatures(events),
      eventCount: events.length,
      generatedAt: new Date().toISOString(),
    };
  }

  async evaluate(
    message: CanonicalMessage,
  ): Promise<PersonalLearningEvaluation> {
    const profile = await this.profile(
      message.tenantId,
      message.accountId,
    );
    const sender = normalizeAddress(message.from?.address);
    const domain = domainFromAddress(sender);
    const thread = message.threadId;

    const matched = profile.features.filter((feature) => {
      if (feature.scope === "sender") return feature.key === sender;
      if (feature.scope === "domain") return feature.key === domain;
      return feature.key === thread;
    });

    const importanceDelta = clamp(
      matched
        .filter((feature) => feature.kind === "importance_adjustment")
        .reduce(
          (sum, feature) =>
            sum + (feature.importanceDelta ?? 0) * feature.confidence,
          0,
        ),
      -35,
      35,
    );

    const replyAffinity = clamp(
      matched
        .filter((feature) => feature.kind === "reply_affinity")
        .reduce(
          (sum, feature) => sum + feature.confidence,
          0,
        ),
      0,
      1,
    );

    const alwaysArchive = matched.some(
      (feature) =>
        feature.kind === "always_archive" &&
        feature.explicit &&
        feature.confidence === 1,
    );
    const neverDelete = matched.some(
      (feature) =>
        feature.kind === "never_delete" &&
        feature.explicit &&
        feature.confidence === 1,
    );
    const avoidArchive = matched.some(
      (feature) =>
        feature.kind === "avoid_archive" &&
        feature.confidence >= 0.5,
    );
    const avoidTrash = matched.some(
      (feature) =>
        feature.kind === "avoid_trash" &&
        feature.confidence >= 0.5,
    );

    return {
      importanceDelta: Math.round(importanceDelta),
      alwaysArchive,
      neverDelete,
      avoidArchive,
      avoidTrash,
      replyAffinity,
      matchedFeatures: matched,
      reasons: matched.map((feature) => feature.reason),
    };
  }

  async export(
    tenantId: string,
    accountId: string,
  ): Promise<PersonalLearningExport> {
    const events = await this.store.list(tenantId, accountId);
    const profile = await this.profile(tenantId, accountId);
    return {
      version: PERSONAL_LEARNING_VERSION,
      tenantId,
      accountId,
      exportedAt: new Date().toISOString(),
      events,
      profile,
    };
  }

  async reset(
    tenantId: string,
    accountId: string,
  ): Promise<number> {
    return this.store.reset(tenantId, accountId);
  }
}
