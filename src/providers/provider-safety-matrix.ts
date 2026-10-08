import type {
  ProviderCapabilities,
  ProviderCapabilityName,
} from "./provider-adapter.js";

export const PROVIDER_SAFETY_SCENARIOS = [
  "authentication",
  "reauthorization",
  "duplicate_events",
  "thread_reads",
  "archive_move",
  "trash_restore",
  "permanent_delete_safeguards",
  "throttling",
  "revoked_credentials",
  "protected_categories",
  "shadow_mode",
  "retention_scheduling",
] as const;

export type ProviderSafetyScenario =
  (typeof PROVIDER_SAFETY_SCENARIOS)[number];

export type SafetyMatrixProvider =
  | "gmail"
  | "microsoft_graph"
  | "imap"
  | "jmap";

export type ProviderSafetyScenarioMode =
  | "native"
  | "fail_closed"
  | "shared_platform";

export interface ProviderSafetyEvidence {
  file: string;
  marker: string;
}

export interface ProviderSafetyScenarioContract {
  mode: ProviderSafetyScenarioMode;
  detail: string;
  evidence: readonly ProviderSafetyEvidence[];
}

export interface ProviderSafetyMatrixEntry {
  provider: SafetyMatrixProvider;
  expectedCapabilities: Readonly<
    Partial<Record<ProviderCapabilityName, boolean>>
  >;
  scenarios: Readonly<
    Record<
      ProviderSafetyScenario,
      ProviderSafetyScenarioContract
    >
  >;
}

const SHARED_SAFETY = {
  protected_categories: {
    mode: "shared_platform",
    detail:
      "Protected messages must block retention mutation before provider execution.",
    evidence: [
      {
        file: "test/retention-scheduler.test.ts",
        marker:
          "message becoming protected blocks the next retention mutation",
      },
      {
        file: "test/retention-scheduler.test.ts",
        marker:
          "protected messages cannot enter automatic retention cleanup",
      },
    ],
  },
  shadow_mode: {
    mode: "shared_platform",
    detail:
      "Archive/trash plans are preview-only until explicit Shadow Mode review enables automation.",
    evidence: [
      {
        file: "test/shadow-mode.test.ts",
        marker:
          "shadow policy coordinator preserves intended archive plan but suppresses execution",
      },
      {
        file: "test/shadow-mode.test.ts",
        marker:
          "shadow policy coordinator suppresses trash while still recording Would Delete",
      },
    ],
  },
  retention_scheduling: {
    mode: "shared_platform",
    detail:
      "Retention re-evaluates policy before destructive stages and remains idempotent.",
    evidence: [
      {
        file: "test/retention-scheduler.test.ts",
        marker:
          "retention lifecycle archives, waits, trashes, waits, then permanently deletes",
      },
      {
        file: "test/retention-scheduler.test.ts",
        marker:
          "policy is re-evaluated again before permanent delete",
      },
      {
        file: "test/retention-scheduler.test.ts",
        marker:
          "schedule is idempotent while an active job exists",
      },
    ],
  },
} as const satisfies Pick<
  Record<
    ProviderSafetyScenario,
    ProviderSafetyScenarioContract
  >,
  | "protected_categories"
  | "shadow_mode"
  | "retention_scheduling"
>;

function shared(
  scenario:
    | "protected_categories"
    | "shadow_mode"
    | "retention_scheduling",
): ProviderSafetyScenarioContract {
  return SHARED_SAFETY[scenario];
}

export const PROVIDER_ACTION_SAFETY_MATRIX:
  Readonly<
    Record<
      SafetyMatrixProvider,
      ProviderSafetyMatrixEntry
    >
  > = Object.freeze({
    gmail: {
      provider: "gmail",
      expectedCapabilities: {
        getThread: true,
        archive: true,
        move: true,
        trash: true,
        restore: true,
        deletePermanent: false,
      },
      scenarios: {
        authentication: {
          mode: "native",
          detail:
            "OAuth uses least-privilege modify scope by default and stores refresh credentials.",
          evidence: [
            {
              file: "test/gmail-connector.test.ts",
              marker:
                "OAuth authorization uses least-privilege Gmail scope by default",
            },
            {
              file: "test/gmail-connector.test.ts",
              marker:
                "OAuth code exchange persists refresh credentials through credential store",
            },
          ],
        },
        reauthorization: {
          mode: "native",
          detail:
            "401 refreshes once; missing/invalid refresh credentials require reauthorization.",
          evidence: [
            {
              file: "test/gmail-connector.test.ts",
              marker:
                "Gmail API retries 429 and succeeds without changing caller semantics",
            },
            {
              file: "src/providers/gmail/gmail-api-client.ts",
              marker:
                "response.status === 401 && !refreshedAfter401",
            },
          ],
        },
        duplicate_events: {
          mode: "shared_platform",
          detail:
            "Provider history replay is reconciled through idempotent canonical ingestion.",
          evidence: [
            {
              file: "test/gmail-connector.test.ts",
              marker:
                "Gmail adapter reconciles history changes and deleted message ids",
            },
            {
              file: "test/ingestion-pipeline.test.ts",
              marker:
                "deduplicated",
            },
          ],
        },
        thread_reads: {
          mode: "native",
          detail:
            "Gmail advertises canonical thread reads through the provider adapter.",
          evidence: [
            {
              file: "src/providers/gmail/gmail-adapter.ts",
              marker:
                "override async getThread",
            },
          ],
        },
        archive_move: {
          mode: "native",
          detail:
            "Archive and move map to Gmail label/folder semantics.",
          evidence: [
            {
              file: "test/gmail-connector.test.ts",
              marker:
                "Gmail actions map to Gmail API and permanent delete is disabled by default",
            },
          ],
        },
        trash_restore: {
          mode: "native",
          detail:
            "Trash and untrash are explicit Gmail API mutations.",
          evidence: [
            {
              file: "test/gmail-connector.test.ts",
              marker:
                "/messages/m1/untrash",
            },
          ],
        },
        permanent_delete_safeguards: {
          mode: "fail_closed",
          detail:
            "Permanent delete is disabled unless explicitly opted in with full-mail scope.",
          evidence: [
            {
              file: "test/gmail-connector.test.ts",
              marker:
                "permanent-delete authorization explicitly requests full-mail scope",
            },
            {
              file: "test/gmail-connector.test.ts",
              marker:
                "permanent delete is disabled by default",
            },
          ],
        },
        throttling: {
          mode: "native",
          detail:
            "429 honors Retry-After and uses bounded retry telemetry.",
          evidence: [
            {
              file: "test/gmail-connector.test.ts",
              marker:
                "Gmail API retries 429 and succeeds without changing caller semantics",
            },
            {
              file: "test/gmail-connector.test.ts",
              marker:
                "provider retry delay honors Retry-After dates and clamps excessive backoff",
            },
          ],
        },
        revoked_credentials: {
          mode: "native",
          detail:
            "Disconnect revokes OAuth access and clears local credentials.",
          evidence: [
            {
              file: "test/gmail-connector.test.ts",
              marker:
                "disconnect revokes OAuth token and clears stored credentials",
            },
          ],
        },
        protected_categories: shared(
          "protected_categories",
        ),
        shadow_mode: shared("shadow_mode"),
        retention_scheduling: shared(
          "retention_scheduling",
        ),
      },
    },
    microsoft_graph: {
      provider: "microsoft_graph",
      expectedCapabilities: {
        getThread: true,
        archive: true,
        move: true,
        trash: true,
        restore: true,
        deletePermanent: false,
      },
      scenarios: {
        authentication: {
          mode: "native",
          detail:
            "OAuth requests offline and Mail.ReadWrite access.",
          evidence: [
            {
              file:
                "test/microsoft-graph-connector.test.ts",
              marker:
                "authorization URL requests offline and read/write mail access",
            },
          ],
        },
        reauthorization: {
          mode: "native",
          detail:
            "401 refreshes once; revoked consent becomes a typed reauthorization requirement.",
          evidence: [
            {
              file:
                "src/providers/microsoft-graph/graph-api-client.ts",
              marker:
                "response.status === 401 && !refreshedAfter401",
            },
            {
              file:
                "test/microsoft-graph-connector.test.ts",
              marker:
                "revoked consent clears stored credentials",
            },
          ],
        },
        duplicate_events: {
          mode: "shared_platform",
          detail:
            "Delta tombstones and repeated sync events converge through canonical ingestion.",
          evidence: [
            {
              file:
                "test/microsoft-graph-connector.test.ts",
              marker:
                "delta sync normalizes live messages and tombstones",
            },
            {
              file: "test/ingestion-pipeline.test.ts",
              marker:
                "deduplicated",
            },
          ],
        },
        thread_reads: {
          mode: "native",
          detail:
            "Graph conversation reads are exposed as canonical threads.",
          evidence: [
            {
              file:
                "src/providers/microsoft-graph/graph-adapter.ts",
              marker:
                "override async getThread",
            },
          ],
        },
        archive_move: {
          mode: "native",
          detail:
            "Archive and move use Graph destination-folder operations.",
          evidence: [
            {
              file:
                "test/microsoft-graph-connector.test.ts",
              marker:
                "Graph actions and subscriptions use provider APIs",
            },
          ],
        },
        trash_restore: {
          mode: "native",
          detail:
            "Deleted Items movement and inbox restoration are provider-native.",
          evidence: [
            {
              file:
                "test/microsoft-graph-connector.test.ts",
              marker:
                "Graph actions and subscriptions use provider APIs",
            },
          ],
        },
        permanent_delete_safeguards: {
          mode: "fail_closed",
          detail:
            "Permanent delete is not exposed by the default Graph capability contract.",
          evidence: [
            {
              file:
                "src/providers/microsoft-graph/graph-adapter.ts",
              marker:
                "const GRAPH_CAPABILITIES",
            },
            {
              file:
                "test/retention-scheduler.test.ts",
              marker:
                "unknown provider semantics never pretend permanent deletion succeeded",
            },
          ],
        },
        throttling: {
          mode: "native",
          detail:
            "429 honors Retry-After with bounded retry and throttle telemetry.",
          evidence: [
            {
              file:
                "test/microsoft-graph-connector.test.ts",
              marker:
                "Graph API retries throttling with Retry-After",
            },
          ],
        },
        revoked_credentials: {
          mode: "native",
          detail:
            "Revoked consent clears stored credentials and requires user reauthorization.",
          evidence: [
            {
              file:
                "test/microsoft-graph-connector.test.ts",
              marker:
                "revoked consent clears stored credentials",
            },
          ],
        },
        protected_categories: shared(
          "protected_categories",
        ),
        shadow_mode: shared("shadow_mode"),
        retention_scheduling: shared(
          "retention_scheduling",
        ),
      },
    },
    imap: {
      provider: "imap",
      expectedCapabilities: {
        getThread: false,
        archive: true,
        move: true,
        trash: true,
        restore: true,
        deletePermanent: false,
      },
      scenarios: {
        authentication: {
          mode: "native",
          detail:
            "OAuth2/app-password are safe defaults; normal password auth needs explicit opt-in.",
          evidence: [
            {
              file: "test/imap-connector.test.ts",
              marker:
                "IMAP auth policy requires explicit opt-in for normal passwords",
            },
          ],
        },
        reauthorization: {
          mode: "fail_closed",
          detail:
            "Credential loss fails connection and requires account credential replacement.",
          evidence: [
            {
              file: "test/imap-connector.test.ts",
              marker:
                "disconnect can remove credential-store record explicitly",
            },
          ],
        },
        duplicate_events: {
          mode: "shared_platform",
          detail:
            "UIDVALIDITY-scoped UIDs and canonical ingestion prevent replay inflation.",
          evidence: [
            {
              file: "test/imap-connector.test.ts",
              marker:
                "UIDVALIDITY change forces safe reconciliation from first UID",
            },
            {
              file: "test/ingestion-pipeline.test.ts",
              marker:
                "deduplicated",
            },
          ],
        },
        thread_reads: {
          mode: "fail_closed",
          detail:
            "IMAP has no provider-neutral server thread contract; getThread capability remains disabled.",
          evidence: [
            {
              file:
                "src/providers/imap/imap-adapter.ts",
              marker:
                "const BASE_IMAP_CAPABILITIES",
            },
          ],
        },
        archive_move: {
          mode: "native",
          detail:
            "Configured Archive folder enables archive; move remains UID-scoped.",
          evidence: [
            {
              file: "test/imap-connector.test.ts",
              marker:
                "IMAP actions use configured folders and flags",
            },
          ],
        },
        trash_restore: {
          mode: "native",
          detail:
            "Configured Trash folder enables trash and inbox restore.",
          evidence: [
            {
              file: "test/imap-connector.test.ts",
              marker:
                "IMAP actions use configured folders and flags",
            },
          ],
        },
        permanent_delete_safeguards: {
          mode: "fail_closed",
          detail:
            "Permanent delete is not a default IMAP adapter capability.",
          evidence: [
            {
              file:
                "src/providers/imap/imap-adapter.ts",
              marker:
                "const BASE_IMAP_CAPABILITIES",
            },
            {
              file:
                "test/retention-scheduler.test.ts",
              marker:
                "without permanent-delete opt-in lifecycle completes after Trash",
            },
          ],
        },
        throttling: {
          mode: "fail_closed",
          detail:
            "IMAP connection/backpressure errors surface to worker retry; adapter does not invent successful mutations.",
          evidence: [
            {
              file:
                "test/retention-scheduler.test.ts",
              marker:
                "unknown provider semantics never pretend permanent deletion succeeded",
            },
          ],
        },
        revoked_credentials: {
          mode: "native",
          detail:
            "Credential-store deletion disconnects future sessions.",
          evidence: [
            {
              file: "test/imap-connector.test.ts",
              marker:
                "disconnect can remove credential-store record explicitly",
            },
          ],
        },
        protected_categories: shared(
          "protected_categories",
        ),
        shadow_mode: shared("shadow_mode"),
        retention_scheduling: shared(
          "retention_scheduling",
        ),
      },
    },
    jmap: {
      provider: "jmap",
      expectedCapabilities: {
        getThread: true,
        archive: true,
        move: true,
        trash: true,
        restore: true,
        deletePermanent: false,
      },
      scenarios: {
        authentication: {
          mode: "native",
          detail:
            "Session discovery uses bearer credentials and validates JMAP core/mail capabilities.",
          evidence: [
            {
              file: "test/jmap-connector.test.ts",
              marker:
                "JMAP session discovery uses bearer token and validates mail capability",
            },
          ],
        },
        reauthorization: {
          mode: "fail_closed",
          detail:
            "Missing bearer credentials fail before network mutation and require credential replacement.",
          evidence: [
            {
              file:
                "src/providers/jmap/jmap-client.ts",
              marker:
                "JMAP access token is not configured",
            },
          ],
        },
        duplicate_events: {
          mode: "shared_platform",
          detail:
            "Email/changes state plus canonical ingestion deduplicates repeated change delivery.",
          evidence: [
            {
              file: "test/jmap-connector.test.ts",
              marker:
                "JMAP adapter performs initial query then Email/changes incremental sync",
            },
            {
              file: "test/ingestion-pipeline.test.ts",
              marker:
                "deduplicated",
            },
          ],
        },
        thread_reads: {
          mode: "native",
          detail:
            "Thread/get and Email/get produce a canonical thread.",
          evidence: [
            {
              file: "test/jmap-connector.test.ts",
              marker:
                "JMAP adapter maps folders and retrieves canonical thread",
            },
          ],
        },
        archive_move: {
          mode: "native",
          detail:
            "Email/set mailboxIds implements archive/move semantics.",
          evidence: [
            {
              file: "test/jmap-connector.test.ts",
              marker:
                "JMAP actions use Email/set and preserve existing keywords",
            },
          ],
        },
        trash_restore: {
          mode: "native",
          detail:
            "Trash/inbox mailboxIds implement trash and restore.",
          evidence: [
            {
              file: "test/jmap-connector.test.ts",
              marker:
                "JMAP actions use Email/set and preserve existing keywords",
            },
          ],
        },
        permanent_delete_safeguards: {
          mode: "fail_closed",
          detail:
            "Permanent delete is absent from the default JMAP capability set.",
          evidence: [
            {
              file:
                "src/providers/jmap/jmap-adapter.ts",
              marker:
                "const JMAP_CAPABILITIES",
            },
            {
              file:
                "test/retention-scheduler.test.ts",
              marker:
                "unknown provider semantics never pretend permanent deletion succeeded",
            },
          ],
        },
        throttling: {
          mode: "fail_closed",
          detail:
            "JMAP HTTP errors surface as typed API failures; retry remains worker-owned until explicit provider retry support exists.",
          evidence: [
            {
              file:
                "src/providers/jmap/jmap-client.ts",
              marker:
                "throw new JmapApiError",
            },
          ],
        },
        revoked_credentials: {
          mode: "native",
          detail:
            "Disconnect removes stored bearer credentials when requested.",
          evidence: [
            {
              file: "test/jmap-connector.test.ts",
              marker:
                "disconnect optionally removes JMAP credentials",
            },
          ],
        },
        protected_categories: shared(
          "protected_categories",
        ),
        shadow_mode: shared("shadow_mode"),
        retention_scheduling: shared(
          "retention_scheduling",
        ),
      },
    },
  });

export function assertProviderSafetyCapabilities(
  provider: SafetyMatrixProvider,
  actual: ProviderCapabilities,
): void {
  const expected =
    PROVIDER_ACTION_SAFETY_MATRIX[provider]
      .expectedCapabilities;
  for (const [
    capability,
    enabled,
  ] of Object.entries(expected) as [
    ProviderCapabilityName,
    boolean,
  ][]) {
    if (
      actual[capability] !== enabled
    ) {
      throw new Error(
        provider +
          " safety capability drift: " +
          capability +
          " expected " +
          String(enabled) +
          " but received " +
          String(actual[capability]),
      );
    }
  }
}
