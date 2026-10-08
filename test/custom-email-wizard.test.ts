import test from "node:test";
import assert from "node:assert/strict";

import {
  CredentialVault,
  CustomEmailAccountWizardService,
  InMemoryAesKeyWrapper,
  InMemoryCustomEmailAccountStore,
  InMemorySecretRecordStore,
  type CustomEmailAccountDraft,
  type CustomEmailConnectionTesters,
  type CustomReceiveConnectionTestResult,
  type ImapConnectionConfig,
  type ImapSecretRecord,
  type Pop3ConnectionConfig,
  type Pop3SecretRecord,
  type ProviderConnectionContext,
  type SmtpConnectionConfig,
  type SmtpConnectionTestResult,
  type SmtpCredentials,
} from "../src/index.js";

function smtpSuccess(
  config: SmtpConnectionConfig,
  credentials: SmtpCredentials,
): SmtpConnectionTestResult {
  const port =
    config.port ??
    (config.tlsMode === "implicit_tls"
      ? 465
      : config.tlsMode === "starttls"
        ? 587
        : 25);
  return {
    ok: true,
    host: config.host,
    port,
    tlsMode: config.tlsMode,
    encrypted: config.tlsMode !== "none",
    certificateStatus:
      config.tlsMode === "none"
        ? "not_applicable"
        : config.rejectUnauthorized === false
          ? "validation_disabled"
          : "validated",
    authMethod: credentials.authMethod,
    checks: {
      connect: "passed",
      tls:
        config.tlsMode === "none"
          ? "not_run"
          : "passed",
      auth: "passed",
    },
    advertisedEhloCapabilities: [
      "AUTH",
      "SIZE",
      "SMTPUTF8",
    ],
    advertisedAuthMechanisms: [
      "PLAIN",
    ],
    smtpUtf8: true,
    maxMessageBytes: 10_000_000,
    accountExternalId:
      credentials.username,
    sentTestMessage: false,
  };
}

function receiveSuccess(
  protocol: "imap" | "pop3",
  host: string,
  port: number,
  tlsMode: "implicit" | "starttls",
  username: string,
): CustomReceiveConnectionTestResult {
  return {
    ok: true,
    protocol,
    host,
    port,
    tlsMode,
    accountExternalId: username,
  };
}

function harness() {
  const secretStore =
    new InMemorySecretRecordStore();
  const vault = new CredentialVault(
    secretStore,
    new InMemoryAesKeyWrapper(
      new Map([
        [
          "key-1",
          Buffer.alloc(32, 9),
        ],
      ]),
      "key-1",
    ),
  );
  const accounts =
    new InMemoryCustomEmailAccountStore();

  const calls = {
    imap: [] as Array<{
      context: ProviderConnectionContext;
      config: ImapConnectionConfig;
      credentials: ImapSecretRecord;
    }>,
    pop3: [] as Array<{
      context: ProviderConnectionContext;
      config: Pop3ConnectionConfig;
      credentials: Pop3SecretRecord;
    }>,
    smtp: [] as Array<{
      config: SmtpConnectionConfig;
      credentials: SmtpCredentials;
    }>,
  };

  const testers: CustomEmailConnectionTesters = {
    async testImap(
      context,
      config,
      credentials,
    ) {
      calls.imap.push({
        context,
        config,
        credentials,
      });
      return receiveSuccess(
        "imap",
        config.host,
        config.port,
        config.tlsMode,
        credentials.username,
      );
    },
    async testPop3(
      context,
      config,
      credentials,
    ) {
      calls.pop3.push({
        context,
        config,
        credentials,
      });
      return receiveSuccess(
        "pop3",
        config.host,
        config.port ??
          (config.tlsMode ===
          "implicit"
            ? 995
            : 110),
        config.tlsMode,
        credentials.username,
      );
    },
    async testSmtp(
      config,
      credentials,
    ) {
      calls.smtp.push({
        config,
        credentials,
      });
      return smtpSuccess(
        config,
        credentials,
      );
    },
  };

  const principal = {
    serviceId:
      "custom-email-onboarding",
    operations: [
      "read",
      "write",
      "delete",
    ] as const,
    tenantIds: ["tenant-1"],
  };

  const service =
    new CustomEmailAccountWizardService(
      accounts,
      vault,
      principal,
      testers,
      () =>
        new Date(
          "2026-10-08T09:30:00.000Z",
        ),
    );

  return {
    service,
    accounts,
    vault,
    secretStore,
    principal,
    calls,
  };
}

function imapSmtpDraft(
  accountId = "account-1",
): CustomEmailAccountDraft {
  return {
    tenantId: "tenant-1",
    accountId,
    email: "Owner@Example.test",
    displayName: "Owner",
    receive: {
      protocol: "imap",
      host: "imap.example.test",
      tlsMode: "implicit",
      authMode: "app_password",
      secret: "imap-super-secret",
    },
    send: {
      host: "smtp.example.test",
      tlsMode: "starttls",
      authMethod: "app_password",
      username:
        "mailer@example.test",
      secret: "smtp-super-secret",
    },
  };
}

test("custom wizard tests IMAP receive and SMTP send independently without persisting secrets", async () => {
  const h = harness();
  const draft = imapSmtpDraft();

  const receive =
    await h.service.testReceive(
      draft,
    );
  assert.equal(receive.ok, true);
  assert.equal(h.calls.imap.length, 1);
  assert.equal(h.calls.smtp.length, 0);
  assert.equal(
    h.calls.imap[0]?.config.port,
    993,
  );
  assert.equal(
    h.calls.imap[0]?.credentials
      .username,
    "owner@example.test",
  );
  assert.equal(
    h.secretStore.records.size,
    0,
  );

  const send =
    await h.service.testSend(draft);
  assert.equal(send.ok, true);
  assert.equal(h.calls.smtp.length, 1);
  assert.equal(
    h.calls.smtp[0]?.config.tlsMode,
    "starttls",
  );
  assert.equal(
    h.calls.smtp[0]?.credentials
      .username,
    "mailer@example.test",
  );
  assert.equal(
    h.secretStore.records.size,
    0,
  );
});


test("saving IMAP + SMTP stores only non-secret profile data and writes both secrets through CredentialVault", async () => {
  const h = harness();
  const draft = imapSmtpDraft();

  const profile =
    await h.service.save(draft);

  assert.equal(
    profile.mode,
    "imap_smtp",
  );
  assert.equal(
    profile.email,
    "owner@example.test",
  );
  assert.equal(
    profile.receive?.host,
    "imap.example.test",
  );
  assert.equal(
    profile.receive?.credentialRef,
    "custom_email_receive",
  );
  assert.equal(
    profile.send?.username,
    "mailer@example.test",
  );
  assert.equal(
    profile.send?.port,
    587,
  );
  assert.equal(
    profile.send?.credentialRef,
    "custom_email_smtp",
  );

  const serialized =
    JSON.stringify(profile);
  assert.equal(
    serialized.includes(
      "imap-super-secret",
    ),
    false,
  );
  assert.equal(
    serialized.includes(
      "smtp-super-secret",
    ),
    false,
  );
  assert.equal(
    h.secretStore.records.size,
    2,
  );
  assert.equal(
    JSON.stringify([
      ...h.secretStore.records.values(),
    ]).includes(
      "imap-super-secret",
    ),
    false,
  );
  assert.equal(
    JSON.stringify([
      ...h.secretStore.records.values(),
    ]).includes(
      "smtp-super-secret",
    ),
    false,
  );

  const receiveSecret =
    await h.vault.getJson<{
      username: string;
      secret: string;
    }>(
      h.principal,
      {
        tenantId: "tenant-1",
        accountId: "account-1",
        name: "custom_email_receive",
      },
    );
  const sendSecret =
    await h.vault.getJson<{
      username: string;
      secret: string;
    }>(
      h.principal,
      {
        tenantId: "tenant-1",
        accountId: "account-1",
        name: "custom_email_smtp",
      },
    );

  assert.equal(
    receiveSecret?.secret,
    "imap-super-secret",
  );
  assert.equal(
    sendSecret?.secret,
    "smtp-super-secret",
  );
  assert.equal(
    sendSecret?.username,
    "mailer@example.test",
  );
});

test("custom wizard supports POP3 + SMTP with protocol defaults and separate SMTP username", async () => {
  const h = harness();
  const draft: CustomEmailAccountDraft = {
    tenantId: "tenant-1",
    accountId: "account-pop3",
    email: "user@example.test",
    receive: {
      protocol: "pop3",
      host: "pop.example.test",
      tlsMode: "implicit",
      authMode: "app_password",
      secret: "pop-secret",
    },
    send: {
      host: "smtp.example.test",
      tlsMode: "implicit_tls",
      authMethod: "oauth2",
      username:
        "smtp-user@example.test",
      accessToken: "oauth-token",
    },
  };

  const receive =
    await h.service.testReceive(
      draft,
    );
  const send =
    await h.service.testSend(draft);
  assert.equal(receive.ok, true);
  assert.equal(send.ok, true);
  assert.equal(h.calls.pop3.length, 1);
  assert.equal(
    h.calls.pop3[0]?.config.port,
    995,
  );
  assert.equal(
    h.calls.smtp[0]?.credentials
      .username,
    "smtp-user@example.test",
  );

  const profile =
    await h.service.save(draft);
  assert.equal(
    profile.mode,
    "pop3_smtp",
  );
  assert.equal(
    profile.receive?.port,
    995,
  );
  assert.equal(
    profile.send?.port,
    465,
  );
});

test("custom wizard supports receive-only and send-only accounts with independent skipped tests", async () => {
  const h = harness();

  const receiveOnly: CustomEmailAccountDraft = {
    tenantId: "tenant-1",
    accountId: "receive-only",
    email: "receive@example.test",
    receive: {
      protocol: "imap",
      host: "imap.example.test",
      tlsMode: "starttls",
      authMode: "app_password",
      secret: "receive-secret",
    },
  };
  const receiveProfile =
    await h.service.save(
      receiveOnly,
    );
  assert.equal(
    receiveProfile.mode,
    "receive_only",
  );
  assert.equal(
    receiveProfile.send,
    undefined,
  );
  assert.deepEqual(
    await h.service.testSend(
      receiveOnly,
    ),
    {
      ok: true,
      skipped: true,
      reason: "send_disabled",
    },
  );

  const sendOnly: CustomEmailAccountDraft = {
    tenantId: "tenant-1",
    accountId: "send-only",
    email: "send@example.test",
    displayName: "Send Only",
    send: {
      host: "smtp.example.test",
      tlsMode: "starttls",
      authMethod: "app_password",
      secret: "send-secret",
    },
  };
  const sendProfile =
    await h.service.save(sendOnly);
  assert.equal(
    sendProfile.mode,
    "send_only",
  );
  assert.equal(
    sendProfile.receive,
    undefined,
  );
  assert.deepEqual(
    await h.service.testReceive(
      sendOnly,
    ),
    {
      ok: true,
      skipped: true,
      reason: "receive_disabled",
    },
  );
});

test("advanced unsafe password settings are explicit and a custom account cannot disable both directions", async () => {
  const h = harness();

  await assert.rejects(
    () =>
      h.service.save({
        tenantId: "tenant-1",
        accountId: "unsafe-imap",
        email: "user@example.test",
        receive: {
          protocol: "imap",
          host: "imap.example.test",
          tlsMode: "implicit",
          authMode: "password",
          secret: "password",
        },
      }),
    /allowPasswordAuth/,
  );

  await assert.rejects(
    () =>
      h.service.save({
        tenantId: "tenant-1",
        accountId: "unsafe-smtp",
        email: "user@example.test",
        send: {
          host: "smtp.example.test",
          tlsMode: "none",
          authMethod: "password",
          secret: "password",
        },
      }),
    /allowPlaintextAuth/,
  );

  await assert.rejects(
    () =>
      h.service.save({
        tenantId: "tenant-1",
        accountId: "empty",
        email: "user@example.test",
      }),
    /enable receive, send, or both/,
  );
});
