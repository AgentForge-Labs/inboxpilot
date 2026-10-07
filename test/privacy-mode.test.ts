import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryMcpControlPlaneUsageStore,
  InMemoryPrivacyModeCloudStore,
  HostedMcpToolRegistry,
  PRIVACY_MODE_CAPABILITIES,
  PRIVACY_MODE_DEPLOYMENT,
  PrivacyBoundaryViolationError,
  PrivacyModeLocalRuntime,
  assertPrivacyModeDeployment,
  parsePrivacyCloudEnvelope,
  privacyCloudMessageId,
  projectPrivacyCloudEnvelope,
  registerPrivacyModeCloudTools,
  type CanonicalMessage,
  type HostedMcpTool,
  type PrivacyCloudClassificationEnvelope,
  type PrivacyModeLocalClassifier,
  type SemanticClassificationResult,
  type SemanticClassifyInput,
} from "../src/index.js";

function message(
  id = "local-message-sensitive-id",
  overrides: Partial<CanonicalMessage> = {},
): CanonicalMessage {
  const base: CanonicalMessage = {
    schemaVersion: 1,
    id,
    tenantId: "tenant-1",
    accountId: "account-1",
    threadId: "LOCAL_THREAD_SECRET",
    provider: {
      kind: "gmail",
      messageId: "PROVIDER_MESSAGE_SECRET",
      threadId: "PROVIDER_THREAD_SECRET",
    },
    internetMessageId:
      "<SECRET_INTERNET_MESSAGE_ID@example.test>",
    subject: "SECRET SUBJECT payroll notice",
    snippet: "SECRET SNIPPET",
    body: {
      text:
        "SUPER_SECRET_BODY password=hunter2 account=12345",
      html:
        "<p>SUPER_SECRET_HTML token=abc123</p>",
      truncated: false,
    },
    from: {
      address: "private.sender@example.test",
      name: "Private Sender",
    },
    to: [
      {
        address: "private.recipient@example.test",
        name: "Private Recipient",
      },
    ],
    cc: [{ address: "private.cc@example.test" }],
    bcc: [{ address: "private.bcc@example.test" }],
    replyTo: [
      { address: "private.reply@example.test" },
    ],
    headers: {
      authorization: [
        "Bearer LOCAL_PROVIDER_CREDENTIAL_SECRET",
      ],
      "x-private-header": ["PRIVATE_HEADER_VALUE"],
    },
    labels: ["private-label"],
    mailboxes: [
      {
        id: "inbox",
        role: "inbox",
        displayName: "Private Inbox",
      },
    ],
    flags: {
      read: false,
      starred: false,
      important: false,
      draft: false,
      answered: false,
      forwarded: false,
    },
    attachments: [
      {
        id: "attachment-local-id",
        providerAttachmentId:
          "PROVIDER_ATTACHMENT_SECRET",
        filename: "PRIVATE_CONTRACT_FILENAME.pdf",
        contentType: "application/pdf",
        sizeBytes: 1234,
        inline: false,
      },
    ],
    receivedAt: "2026-10-07T14:00:00.000Z",
    authentication: {
      spf: "pass",
      dkim: "pass",
      dmarc: "pass",
      transportEncrypted: true,
    },
    classification: {
      status: "unclassified",
      categories: [],
    },
    retention: {
      stage: "active",
      protected: false,
      protectionReasons: [],
    },
    providerMetadata: {
      rawSecret: "PRIVATE_PROVIDER_METADATA",
    },
    ingestedAt: "2026-10-07T14:00:01.000Z",
    updatedAt: "2026-10-07T14:00:01.000Z",
  };

  return {
    ...base,
    ...overrides,
    provider: overrides.provider ?? base.provider,
    body: overrides.body ?? base.body,
    headers: overrides.headers ?? base.headers,
    authentication:
      overrides.authentication ?? base.authentication,
    classification:
      overrides.classification ?? base.classification,
    retention: overrides.retention ?? base.retention,
    flags: overrides.flags ?? base.flags,
    mailboxes: overrides.mailboxes ?? base.mailboxes,
    attachments:
      overrides.attachments ?? base.attachments,
  };
}

function semanticResult(
  overrides: Partial<SemanticClassificationResult> = {},
): SemanticClassificationResult {
  return {
    route: "semantic",
    deterministic: {
      importanceScore: 78,
      priority: "important",
      confidence: 0.72,
      contributions: [],
      categoryHints: ["legal"],
      actionRequiredHint: true,
      replyRequiredHint: false,
      needsLlm: true,
      llmDecisionReason: "semantic_ambiguity",
    },
    semantic: {
      contractVersion: 1,
      importanceScore: 82,
      priority: "important",
      categories: ["legal"],
      actionRequired: true,
      replyRequired: false,
      spamRisk: 2,
      phishingRisk: 1,
      confidence: 0.96,
      recommendedAction: "keep_in_inbox",
      retention: {
        disposition: "protect",
        protected: true,
        protectionReasons: ["legal"],
      },
      reason:
        "SECRET MODEL REASON quoting SUPER_SECRET_BODY",
      modelVersion: "local-model-private-version",
    },
    classification: {
      status: "classified",
      modelVersion: "local-model-private-version",
      importanceScore: 82,
      priority: "important",
      categories: ["legal"],
      confidence: 0.96,
      actionRequired: true,
      replyRequired: false,
      riskScore: 2,
      reason:
        "SECRET CLASSIFICATION REASON quoting private sender",
      classifiedAt: "2026-10-07T14:00:02.000Z",
    },
    needsReview: false,
    quotaCharged: true,
    model: "local-model-private-version",
    attempts: 1,
    attachmentEnrichment: {
      attempted: 1,
      extracted: 1,
      skipped: 0,
      failed: 0,
      totalExtractedChars: 999,
      transient: true,
    },
    ...overrides,
  };
}

class RecordingLocalClassifier
  implements PrivacyModeLocalClassifier
{
  readonly executionLocation =
    "local_self_hosted" as const;
  readonly inputs: SemanticClassifyInput[] = [];

  constructor(
    private readonly result: SemanticClassificationResult,
    readonly localCredential =
      "LOCAL_OAUTH_REFRESH_TOKEN_SECRET",
  ) {}

  async classify(
    input: SemanticClassifyInput,
  ): Promise<SemanticClassificationResult> {
    this.inputs.push(input);
    assert.equal(
      input.message.body.text?.includes(
        "SUPER_SECRET_BODY",
      ),
      true,
    );
    assert.equal(
      input.message.headers.authorization?.[0],
      "Bearer LOCAL_PROVIDER_CREDENTIAL_SECRET",
    );
    return structuredClone(this.result);
  }
}

class RecordingCloudSink {
  readonly received: PrivacyCloudClassificationEnvelope[] =
    [];

  async put(
    envelope: PrivacyCloudClassificationEnvelope,
  ): Promise<void> {
    this.received.push(structuredClone(envelope));
  }
}

test("privacy cloud projection contains only strict classification metadata and opaque routing identity", () => {
  const mail = message();
  const envelope = projectPrivacyCloudEnvelope(
    mail,
    semanticResult(),
    () => new Date("2026-10-07T14:00:03.000Z"),
  );

  assert.deepEqual(Object.keys(envelope).sort(), [
    "accountId",
    "classification",
    "cloudMessageId",
    "envelopeVersion",
    "mode",
    "receivedAt",
    "tenantId",
  ]);
  assert.deepEqual(
    Object.keys(envelope.classification).sort(),
    [
      "actionRequired",
      "categories",
      "classifiedAt",
      "confidence",
      "importanceScore",
      "priority",
      "replyRequired",
      "riskScore",
      "status",
    ],
  );

  const serialized = JSON.stringify(envelope);
  for (const secret of [
    "SUPER_SECRET_BODY",
    "SUPER_SECRET_HTML",
    "SECRET SUBJECT",
    "SECRET SNIPPET",
    "private.sender",
    "private.recipient",
    "LOCAL_PROVIDER_CREDENTIAL_SECRET",
    "PROVIDER_MESSAGE_SECRET",
    "PROVIDER_THREAD_SECRET",
    "PROVIDER_ATTACHMENT_SECRET",
    "PRIVATE_CONTRACT_FILENAME",
    "PRIVATE_PROVIDER_METADATA",
    "SECRET MODEL REASON",
    "SECRET CLASSIFICATION REASON",
    "local-model-private-version",
    "LOCAL_THREAD_SECRET",
    "SECRET_INTERNET_MESSAGE_ID",
  ]) {
    assert.equal(
      serialized.includes(secret),
      false,
      "cloud envelope leaked: " + secret,
    );
  }

  assert.match(
    envelope.cloudMessageId,
    /^priv_[0-9a-f]{64}$/,
  );
  assert.equal(
    envelope.cloudMessageId.includes(mail.id),
    false,
  );
});

test("opaque privacy message IDs are stable but tenant/account scoped", () => {
  const base = message("same-local-id");
  const same = privacyCloudMessageId(base);
  assert.equal(privacyCloudMessageId(base), same);

  const otherTenant = privacyCloudMessageId({
    ...base,
    tenantId: "tenant-2",
  });
  const otherAccount = privacyCloudMessageId({
    ...base,
    accountId: "account-2",
  });

  assert.notEqual(same, otherTenant);
  assert.notEqual(same, otherAccount);
  assert.equal(
    same.includes("same-local-id"),
    false,
  );
});

test("strict cloud ingress rejects raw content, credentials, provider IDs and classifier reason fields", () => {
  const good = projectPrivacyCloudEnvelope(
    message(),
    semanticResult(),
  );

  const forbiddenPayloads: unknown[] = [
    {
      ...good,
      body: "SECRET",
    },
    {
      ...good,
      credentials: {
        refreshToken: "SECRET",
      },
    },
    {
      ...good,
      providerMessageId: "SECRET",
    },
    {
      ...good,
      subject: "SECRET",
    },
    {
      ...good,
      classification: {
        ...good.classification,
        reason: "SECRET",
      },
    },
    {
      ...good,
      classification: {
        ...good.classification,
        modelVersion: "private-model",
      },
    },
  ];

  for (const payload of forbiddenPayloads) {
    assert.throws(
      () => parsePrivacyCloudEnvelope(payload),
      PrivacyBoundaryViolationError,
    );
  }
});

test("privacy envelope validation rejects malformed scores, unknown categories and non-opaque IDs", () => {
  const good = projectPrivacyCloudEnvelope(
    message(),
    semanticResult(),
  );

  assert.throws(
    () =>
      parsePrivacyCloudEnvelope({
        ...good,
        cloudMessageId: "provider-message-123",
      }),
    /opaque privacy identifier/,
  );
  assert.throws(
    () =>
      parsePrivacyCloudEnvelope({
        ...good,
        classification: {
          ...good.classification,
          importanceScore: 101,
        },
      }),
    /between 0 and 100/,
  );
  assert.throws(
    () =>
      parsePrivacyCloudEnvelope({
        ...good,
        classification: {
          ...good.classification,
          categories: ["legal", "private-secret-tag"],
        },
      }),
    /unknown category/,
  );
});

test("deterministic local classifications project without cloud semantic execution", () => {
  const result: SemanticClassificationResult = {
    route: "deterministic",
    deterministic: {
      importanceScore: 15,
      priority: "very_low",
      confidence: 0.93,
      contributions: [],
      categoryHints: ["promotion"],
      actionRequiredHint: false,
      replyRequiredHint: false,
      needsLlm: false,
      llmDecisionReason: "high_confidence_bulk",
    },
    needsReview: false,
    quotaCharged: true,
    attempts: 0,
  };

  const envelope = projectPrivacyCloudEnvelope(
    message("deterministic"),
    result,
    () => new Date("2026-10-07T14:10:00.000Z"),
  );

  assert.deepEqual(envelope.classification, {
    status: "classified",
    importanceScore: 15,
    priority: "very_low",
    categories: ["promotion"],
    confidence: 0.93,
    actionRequired: false,
    replyRequired: false,
    classifiedAt: "2026-10-07T14:10:00.000Z",
  });
});

test("local runtime gives full content only to local classifier and publishes metadata-only envelope", async () => {
  const classifier = new RecordingLocalClassifier(
    semanticResult(),
  );
  const cloud = new RecordingCloudSink();
  const runtime = new PrivacyModeLocalRuntime(
    PRIVACY_MODE_DEPLOYMENT,
    classifier,
    cloud,
    () => new Date("2026-10-07T14:20:00.000Z"),
  );
  const mail = message();

  const result = await runtime.classifyAndPublish({
    message: mail,
    history: {
      userAddresses: [
        "private.recipient@example.test",
      ],
    },
    threadContext: [
      message("thread-secret-message", {
        subject: "SECRET PRIOR THREAD SUBJECT",
        body: {
          text: "SECRET PRIOR THREAD BODY",
          truncated: false,
        },
      }),
    ],
  });

  assert.equal(classifier.inputs.length, 1);
  assert.equal(cloud.received.length, 1);
  assert.deepEqual(
    cloud.received[0],
    result.cloudEnvelope,
  );

  const cloudSerialized = JSON.stringify(
    cloud.received[0],
  );
  for (const localOnly of [
    "SUPER_SECRET_BODY",
    "SECRET PRIOR THREAD",
    "LOCAL_OAUTH_REFRESH_TOKEN_SECRET",
    "LOCAL_PROVIDER_CREDENTIAL_SECRET",
    "PRIVATE_CONTRACT_FILENAME",
    "SECRET CLASSIFICATION REASON",
  ]) {
    assert.equal(
      cloudSerialized.includes(localOnly),
      false,
    );
  }

  assert.equal(
    JSON.stringify(result.localClassification).includes(
      "SECRET CLASSIFICATION REASON",
    ),
    true,
  );
});

test("attachment enrichment summary and extracted content never cross privacy cloud boundary", async () => {
  const localResult = semanticResult({
    attachmentEnrichment: {
      attempted: 2,
      extracted: 1,
      skipped: 1,
      failed: 0,
      totalExtractedChars: 12000,
      transient: true,
    },
  });
  const classifier =
    new RecordingLocalClassifier(localResult);
  const cloud = new RecordingCloudSink();
  const runtime = new PrivacyModeLocalRuntime(
    PRIVACY_MODE_DEPLOYMENT,
    classifier,
    cloud,
  );

  await runtime.classifyAndPublish({
    message: message("attachment-private"),
    history: {
      userAddresses: [
        "private.recipient@example.test",
      ],
    },
  });

  const serialized = JSON.stringify(
    cloud.received[0],
  );
  assert.equal(
    serialized.includes("attachmentEnrichment"),
    false,
  );
  assert.equal(
    serialized.includes("totalExtractedChars"),
    false,
  );
  assert.equal(
    serialized.includes("PRIVATE_CONTRACT_FILENAME"),
    false,
  );
});

test("privacy deployment contract fails closed when content, credentials or classifier transport would leave local boundary", () => {
  assert.deepEqual(
    assertPrivacyModeDeployment(
      PRIVACY_MODE_DEPLOYMENT,
    ),
    PRIVACY_MODE_DEPLOYMENT,
  );

  const invalid = [
    {
      ...PRIVACY_MODE_DEPLOYMENT,
      providerCredentials: "cloud",
    },
    {
      ...PRIVACY_MODE_DEPLOYMENT,
      emailContent: "cloud",
    },
    {
      ...PRIVACY_MODE_DEPLOYMENT,
      attachmentContent: "cloud",
    },
    {
      ...PRIVACY_MODE_DEPLOYMENT,
      classifierExecution: "cloud",
    },
    {
      ...PRIVACY_MODE_DEPLOYMENT,
      classifierTransport: "public_cloud",
    },
    {
      ...PRIVACY_MODE_DEPLOYMENT,
      cloudSync: "full_message",
    },
  ];

  for (const descriptor of invalid) {
    assert.throws(
      () =>
        assertPrivacyModeDeployment(
          descriptor as never,
        ),
      /Privacy Mode requires/,
    );
  }

  assert.throws(
    () =>
      assertPrivacyModeDeployment({
        ...PRIVACY_MODE_DEPLOYMENT,
        extraLeakChannel: true,
      } as never),
    /unknown field/,
  );
});

test("privacy capabilities explicitly disable cloud content/provider operations while retaining local automation", () => {
  assert.deepEqual(PRIVACY_MODE_CAPABILITIES, {
    cloudMessageBodyRead: false,
    cloudFullTextSearch: false,
    cloudAttachmentRead: false,
    cloudProviderCredentials: false,
    cloudProviderMutations: false,
    cloudSenderRecipientMetadata: false,
    cloudClassificationMetadata: true,
    localClassification: true,
    localAttachmentExtraction: true,
    localAutomation: true,
  });
});

test("cloud metadata store revalidates payload and remains tenant/account isolated", async () => {
  const store = new InMemoryPrivacyModeCloudStore();
  const t1 = projectPrivacyCloudEnvelope(
    message("same-id"),
    semanticResult(),
  );
  const t2 = projectPrivacyCloudEnvelope(
    message("same-id", {
      tenantId: "tenant-2",
      accountId: "account-2",
    }),
    semanticResult(),
  );

  await store.put(t1);
  await store.put(t2);

  assert.equal(
    (
      await store.listForAccount(
        "tenant-1",
        "account-1",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await store.listForAccount(
        "tenant-2",
        "account-2",
      )
    ).length,
    1,
  );
  assert.equal(
    await store.get(
      "tenant-1",
      "account-1",
      t2.cloudMessageId,
    ),
    undefined,
  );

  await assert.rejects(
    () =>
      store.ingestUnknown({
        ...t1,
        headers: {
          authorization: "SECRET",
        },
      }),
    PrivacyBoundaryViolationError,
  );
});

function tool(name: string): HostedMcpTool {
  return {
    descriptor: {
      name,
      description: name,
      inputSchema: {
        type: "object",
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async execute() {
      return { ok: true };
    },
  };
}

test("privacy cloud MCP registration blocks content, cloud classification and provider-action tools", () => {
  const registry = new HostedMcpToolRegistry(
    new InMemoryMcpControlPlaneUsageStore(),
  );
  const candidates = [
    "email_rule_create",
    "email_rule_update",
    "email_rule_list",
    "email_rule_delete",
    "email_automation_status",
    "email_automation_configure",
    "email_usage",
    "email_search",
    "email_read",
    "email_thread_read",
    "email_inbox_summary",
    "email_classify",
    "email_classify_bulk",
    "email_archive",
    "email_trash",
    "email_restore",
    "email_move",
    "email_mark_important",
    "email_rule_create_natural_language",
  ].map(tool);

  const selection = registerPrivacyModeCloudTools(
    registry,
    candidates,
  );

  assert.deepEqual(selection.registered, [
    "email_automation_configure",
    "email_automation_status",
    "email_rule_create",
    "email_rule_delete",
    "email_rule_list",
    "email_rule_update",
    "email_usage",
  ]);

  for (const blocked of [
    "email_search",
    "email_read",
    "email_thread_read",
    "email_inbox_summary",
    "email_classify",
    "email_classify_bulk",
    "email_archive",
    "email_trash",
    "email_restore",
    "email_move",
    "email_mark_important",
    "email_rule_create_natural_language",
  ]) {
    assert.ok(selection.blocked.includes(blocked));
  }
});
