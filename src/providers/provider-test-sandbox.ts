const LIVE_CREDENTIAL_KEYS = [
  "GMAIL_REFRESH_TOKEN",
  "GMAIL_ACCESS_TOKEN",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "MICROSOFT_REFRESH_TOKEN",
  "MICROSOFT_ACCESS_TOKEN",
  "MICROSOFT_CLIENT_SECRET",
  "IMAP_PASSWORD",
  "IMAP_APP_PASSWORD",
  "IMAP_ACCESS_TOKEN",
  "JMAP_ACCESS_TOKEN",
] as const;

export interface ProviderTestSandboxEnvironment {
  readonly [key: string]: string | undefined;
}

export function assertProviderTestSandboxEnvironment(
  env: ProviderTestSandboxEnvironment,
): void {
  const inCi =
    (env.CI ?? "").trim().toLowerCase() ===
      "true" ||
    (env.GITHUB_ACTIONS ?? "")
      .trim()
      .toLowerCase() === "true";

  if (!inCi) {
    return;
  }

  if (
    env.INBOXPILOT_PROVIDER_TEST_ENV !==
    "sandbox"
  ) {
    throw new Error(
      "Provider integration CI must set INBOXPILOT_PROVIDER_TEST_ENV=sandbox",
    );
  }

  if (
    (env.INBOXPILOT_PROVIDER_TEST_ALLOW_LIVE ??
      "")
      .trim()
      .toLowerCase() === "true"
  ) {
    throw new Error(
      "Provider integration CI cannot enable live mailbox access",
    );
  }

  const exposed = LIVE_CREDENTIAL_KEYS.filter(
    (key) => Boolean(env[key]?.trim()),
  );
  if (exposed.length > 0) {
    throw new Error(
      "Provider integration CI must not receive production credential variables: " +
        exposed.join(", "),
    );
  }
}

export function providerSandboxEnvironment(
  env: ProviderTestSandboxEnvironment,
): "local_mock" | "ci_sandbox" {
  const inCi =
    (env.CI ?? "").trim().toLowerCase() ===
      "true" ||
    (env.GITHUB_ACTIONS ?? "")
      .trim()
      .toLowerCase() === "true";

  if (!inCi) {
    return "local_mock";
  }
  assertProviderTestSandboxEnvironment(env);
  return "ci_sandbox";
}
