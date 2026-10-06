import type { CanonicalMessage } from "../domain/email-model.js";

export const PERSONAL_LEARNING_VERSION = 1 as const;

export type LearningEventType =
  | "explicit_important"
  | "explicit_not_important"
  | "always_archive_sender"
  | "never_delete_sender"
  | "never_delete_domain"
  | "manual_mark_important"
  | "manual_mark_not_important"
  | "manual_archive"
  | "manual_keep_in_inbox"
  | "manual_trash"
  | "restore_from_archive"
  | "restore_from_trash"
  | "user_replied";

export type LearningEventSource =
  | "explicit_correction"
  | "manual_action"
  | "observed_behavior";

export interface LearningSubject {
  sender?: string;
  domain?: string;
  threadId?: string;
  categories?: string[];
}

export interface PersonalLearningEvent {
  version: typeof PERSONAL_LEARNING_VERSION;
  id: string;
  tenantId: string;
  accountId: string;
  type: LearningEventType;
  source: LearningEventSource;
  subject: LearningSubject;
  occurredAt: string;
}

export type PersonalFeatureKind =
  | "importance_adjustment"
  | "always_archive"
  | "never_delete"
  | "avoid_archive"
  | "avoid_trash"
  | "reply_affinity";

export type PersonalFeatureScope = "sender" | "domain" | "thread";

export interface PersonalPreferenceFeature {
  kind: PersonalFeatureKind;
  scope: PersonalFeatureScope;
  key: string;
  confidence: number;
  evidenceCount: number;
  explicit: boolean;
  importanceDelta?: number;
  reason: string;
  updatedAt: string;
}

export interface PersonalLearningProfile {
  version: typeof PERSONAL_LEARNING_VERSION;
  tenantId: string;
  accountId: string;
  features: PersonalPreferenceFeature[];
  eventCount: number;
  generatedAt: string;
}

export interface PersonalLearningEvaluation {
  importanceDelta: number;
  alwaysArchive: boolean;
  neverDelete: boolean;
  avoidArchive: boolean;
  avoidTrash: boolean;
  replyAffinity: number;
  matchedFeatures: PersonalPreferenceFeature[];
  reasons: string[];
}

export interface PersonalLearningExport {
  version: typeof PERSONAL_LEARNING_VERSION;
  tenantId: string;
  accountId: string;
  exportedAt: string;
  events: PersonalLearningEvent[];
  profile: PersonalLearningProfile;
}

export interface PersonalLearningStore {
  append(event: PersonalLearningEvent): Promise<boolean>;
  list(tenantId: string, accountId: string): Promise<PersonalLearningEvent[]>;
  reset(tenantId: string, accountId: string): Promise<number>;
}

export interface LearningEventInput {
  id: string;
  type: LearningEventType;
  source: LearningEventSource;
  occurredAt?: string;
  message: CanonicalMessage;
}
