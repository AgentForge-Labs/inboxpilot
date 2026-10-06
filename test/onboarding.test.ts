import test from "node:test";
import assert from "node:assert/strict";
import {
  MailboxOnboardingService,
  ONBOARDING_ENTRY_OPTIONS,
  buildConnectionHealth,
  createLocalMailboxProfile,
  createManualImapProfile,
  discoverEmailProvider,
  resolveGenericWizard,
  type ProviderDiscoveryNetwork,
} from "../src/index.js";

class FakeNetwork implements ProviderDiscoveryNetwork {
  constructor(
    private readonly mx: Array<{ exchange: string; priority: number }> = [],
    private readonly srv: Record<
      string,
      Array<{ name: string; port: number; priority: number; weight: number }>
    > = {},
  ) {}

  async resolveMx() {
    return this.mx;
  }

  async resolveSrv(name: string) {
    return this.srv[name] ?? [];
  }
}

test("onboarding exposes Google, Microsoft, generic and local entry choices", () => {
  assert.deepEqual(
    ONBOARDING_ENTRY_OPTIONS.map((option) => option.kind),
    ["google", "microsoft", "generic_email", "local_mailbox"],
  );
});

test("known Gmail address routes directly to Google OAuth", async () => {
  const discovery = await discoverEmailProvider(
    "User@Gmail.com",
    new FakeNetwork(),
  );
  assert.equal(discovery.provider, "google");
  assert.equal(discovery.confidence, "high");

  const wizard = resolveGenericWizard(discovery);
  assert.deepEqual(wizard, {
    mode: "redirect_oauth",
    provider: "google",
    email: "user@gmail.com",
    advancedSetupRequired: false,
  });
});

test("custom-domain Google Workspace is recognized from MX", async () => {
  const discovery = await discoverEmailProvider(
    "owner@example.com",
    new FakeNetwork([
      { exchange: "aspmx.l.google.com", priority: 10 },
      { exchange: "alt1.aspmx.l.google.com", priority: 20 },
    ]),
  );

  assert.equal(discovery.provider, "google");
  assert.equal(discovery.advancedSetupRequired, false);
  assert.match(discovery.evidence.join(" "), /mx-provider:google/);
});

test("custom-domain Microsoft 365 is recognized from MX", async () => {
  const discovery = await discoverEmailProvider(
    "owner@example.org",
    new FakeNetwork([
      {
        exchange: "example-org.mail.protection.outlook.com",
        priority: 0,
      },
    ]),
  );

  assert.equal(discovery.provider, "microsoft");
  assert.equal(resolveGenericWizard(discovery).mode, "redirect_oauth");
});

test("generic provider discovers secure IMAP and submission from SRV", async () => {
  const domain = "company.test";
  const discovery = await discoverEmailProvider(
    `mail@${domain}`,
    new FakeNetwork(
      [{ exchange: "mx.company.test", priority: 10 }],
      {
        [`_imaps._tcp.${domain}`]: [
          {
            name: "imap.company.test.",
            port: 993,
            priority: 10,
            weight: 5,
          },
        ],
        [`_submission._tcp.${domain}`]: [
          {
            name: "smtp.company.test.",
            port: 587,
            priority: 10,
            weight: 5,
          },
        ],
      },
    ),
  );

  assert.equal(discovery.provider, "imap");
  assert.equal(discovery.incoming?.host, "imap.company.test");
  assert.equal(discovery.incoming?.tlsMode, "implicit");
  assert.equal(discovery.outgoing?.host, "smtp.company.test");
  assert.equal(discovery.outgoing?.tlsMode, "starttls");

  const wizard = resolveGenericWizard(discovery);
  assert.equal(wizard.mode, "imap");
  if (wizard.mode === "imap") {
    assert.equal(wizard.profile.username, `mail@${domain}`);
    assert.equal(wizard.profile.authMode, "app_password");
    assert.equal(wizard.profile.tlsMode, "implicit");
  }
});

test("unknown provider falls back to advanced setup instead of guessing server credentials", async () => {
  const discovery = await discoverEmailProvider(
    "user@unknown.test",
    new FakeNetwork([{ exchange: "mx.unknown.test", priority: 10 }]),
  );
  assert.equal(discovery.provider, "unknown");
  assert.equal(discovery.advancedSetupRequired, true);

  const wizard = resolveGenericWizard(discovery);
  assert.deepEqual(wizard, {
    mode: "advanced",
    email: "user@unknown.test",
    suggestedDomain: "unknown.test",
    advancedSetupRequired: true,
  });
});

test("Fastmail preset resolves to JMAP without advanced IMAP fields", async () => {
  const service = new MailboxOnboardingService(new FakeNetwork());
  const wizard = await service.resolveGeneric("user@fastmail.com");

  assert.equal(wizard.mode, "jmap");
  if (wizard.mode === "jmap") {
    assert.equal(
      wizard.sessionUrl,
      "https://api.fastmail.com/jmap/session",
    );
    assert.equal(wizard.advancedSetupRequired, false);
  }
});

test("manual IMAP profile enforces TLS-safe onboarding and does not accept normal passwords", () => {
  const profile = createManualImapProfile({
    email: "user@example.test",
    host: "imap.example.test",
    port: 993,
    tlsMode: "implicit",
    authMode: "app_password",
  });

  assert.equal(profile.config.rejectUnauthorized, true);
  assert.equal(profile.config.host, "imap.example.test");
  assert.equal("secret" in profile, false);

  assert.throws(
    () =>
      createManualImapProfile({
        email: "user@example.test",
        host: "imap.example.test",
        port: 993,
        tlsMode: "implicit",
        authMode: "password",
      }),
    /not enabled during onboarding/,
  );

  assert.throws(
    () =>
      createManualImapProfile({
        email: "user@example.test",
        host: "localhost",
        port: 993,
        tlsMode: "implicit",
        authMode: "app_password",
      }),
    /valid mail server hostname/,
  );
});

test("local mailbox onboarding defaults to read-only and gates destructive mode", () => {
  const safe = createLocalMailboxProfile({
    kind: "maildir",
    sourcePath: "/mail/inbox",
    allowedRoot: "/mail",
    statePath: "/mail/.inboxpilot/state.json",
  });
  assert.equal(safe.writable, false);
  assert.equal(safe.destructiveActionsEnabled, false);

  assert.throws(
    () =>
      createLocalMailboxProfile({
        kind: "maildir",
        sourcePath: "/mail/inbox",
        allowedRoot: "/mail",
        statePath: "/mail/.inboxpilot/state.json",
        destructiveActionsEnabled: true,
      }),
    /require writable mode/,
  );
});

test("connection health exposes granted scopes and correct recovery actions", () => {
  const healthy = buildConnectionHealth({
    provider: "gmail",
    connected: true,
    lastSyncAt: "2026-10-06T10:00:00Z",
    lastSuccessfulSyncAt: "2026-10-06T10:00:00Z",
    grantedScopes: ["gmail.modify", "gmail.modify"],
  });
  assert.equal(healthy.state, "healthy");
  assert.deepEqual(healthy.grantedScopes, ["gmail.modify"]);
  assert.deepEqual(healthy.actions, ["disconnect"]);

  const reauth = buildConnectionHealth({
    provider: "microsoft_graph",
    connected: true,
    reauthRequired: true,
    lastError: "consent revoked",
  });
  assert.equal(reauth.state, "reauth_required");
  assert.deepEqual(reauth.actions, ["reauthorize", "disconnect"]);

  const degraded = buildConnectionHealth({
    provider: "imap",
    connected: true,
    lastError: "timeout",
  });
  assert.equal(degraded.state, "degraded");
  assert.deepEqual(degraded.actions, ["retry_sync", "disconnect"]);

  const disconnected = buildConnectionHealth({
    provider: "jmap",
    connected: false,
  });
  assert.equal(disconnected.state, "disconnected");
  assert.deepEqual(disconnected.actions, ["reconnect"]);
});

test("invalid discovery domains are rejected before DNS lookup", async () => {
  let queried = false;
  const network: ProviderDiscoveryNetwork = {
    async resolveMx() {
      queried = true;
      return [];
    },
    async resolveSrv() {
      queried = true;
      return [];
    },
  };

  await assert.rejects(
    () => discoverEmailProvider("user@127.0.0.1", network),
    /not valid/,
  );
  assert.equal(queried, false);
});
