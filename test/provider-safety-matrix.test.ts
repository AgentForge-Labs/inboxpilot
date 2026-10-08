import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  PROVIDER_ACTION_SAFETY_MATRIX,
  PROVIDER_SAFETY_SCENARIOS,
  assertProviderSafetyCapabilities,
  assertProviderTestSandboxEnvironment,
  providerSandboxEnvironment,
  unsupportedCapabilities,
  type ProviderCapabilityName,
  type ProviderCapabilities,
  type SafetyMatrixProvider,
} from "../src/index.js";

const providers: readonly SafetyMatrixProvider[] = [
  "gmail",
  "microsoft_graph",
  "imap",
  "jmap",
];

function fixtureCapabilities(
  provider: SafetyMatrixProvider,
): ProviderCapabilities {
  const expected =
    PROVIDER_ACTION_SAFETY_MATRIX[provider].expectedCapabilities;
  const enabled = Object.entries(expected)
    .filter(([, value]) => value)
    .map(([name]) => name as ProviderCapabilityName);
  return unsupportedCapabilities(enabled);
}

test("provider safety matrix covers every required provider and safety scenario", () => {
  assert.deepEqual(
    Object.keys(PROVIDER_ACTION_SAFETY_MATRIX).sort(),
    [...providers].sort(),
  );

  for (const provider of providers) {
    const entry = PROVIDER_ACTION_SAFETY_MATRIX[provider];
    assert.equal(entry.provider, provider);
    assert.deepEqual(
      Object.keys(entry.scenarios).sort(),
      [...PROVIDER_SAFETY_SCENARIOS].sort(),
    );

    for (const scenario of PROVIDER_SAFETY_SCENARIOS) {
      const contract = entry.scenarios[scenario];
      assert.ok(contract.detail.trim().length > 0);
      assert.ok(
        contract.evidence.length > 0,
        `${provider}/${scenario} must link executable evidence`,
      );
    }
  }
});

test("every safety-matrix evidence marker resolves to repository source or tests", () => {
  for (const provider of providers) {
    for (const scenario of PROVIDER_SAFETY_SCENARIOS) {
      for (const evidence of
        PROVIDER_ACTION_SAFETY_MATRIX[provider].scenarios[scenario].evidence) {
        assert.match(
          evidence.file,
          /^(src|test)\//,
          `${provider}/${scenario} evidence must remain repository-local`,
        );
        const file = resolve(process.cwd(), evidence.file);
        const source = readFileSync(file, "utf8");
        assert.ok(
          source.includes(evidence.marker),
          `${provider}/${scenario} evidence marker missing: ${evidence.file} :: ${evidence.marker}`,
        );
      }
    }
  }
});

test("matrix capability expectations detect provider contract drift", () => {
  for (const provider of providers) {
    const capabilities = fixtureCapabilities(provider);
    assert.doesNotThrow(() =>
      assertProviderSafetyCapabilities(provider, capabilities),
    );

    const [firstExpected] = Object.keys(
      PROVIDER_ACTION_SAFETY_MATRIX[provider].expectedCapabilities,
    ) as ProviderCapabilityName[];
    assert.ok(firstExpected);
    const drifted = {
      ...capabilities,
      [firstExpected]: !capabilities[firstExpected],
    };
    assert.throws(
      () => assertProviderSafetyCapabilities(provider, drifted),
      /safety capability drift/,
    );
  }
});

test("provider integration CI is fenced to explicit sandbox mode", () => {
  assert.throws(
    () => assertProviderTestSandboxEnvironment({ CI: "true" }),
    /INBOXPILOT_PROVIDER_TEST_ENV=sandbox/,
  );
  assert.throws(
    () =>
      assertProviderTestSandboxEnvironment({
        CI: "true",
        INBOXPILOT_PROVIDER_TEST_ENV: "sandbox",
        INBOXPILOT_PROVIDER_TEST_ALLOW_LIVE: "true",
      }),
    /cannot enable live mailbox access/,
  );
  assert.throws(
    () =>
      assertProviderTestSandboxEnvironment({
        GITHUB_ACTIONS: "true",
        INBOXPILOT_PROVIDER_TEST_ENV: "sandbox",
        GMAIL_REFRESH_TOKEN: "live-secret",
      }),
    /must not receive production credential variables: GMAIL_REFRESH_TOKEN/,
  );

  assert.doesNotThrow(() =>
    assertProviderTestSandboxEnvironment({
      CI: "true",
      INBOXPILOT_PROVIDER_TEST_ENV: "sandbox",
    }),
  );
  assert.equal(
    providerSandboxEnvironment({
      CI: "true",
      INBOXPILOT_PROVIDER_TEST_ENV: "sandbox",
    }),
    "ci_sandbox",
  );
  assert.equal(providerSandboxEnvironment({}), "local_mock");
});

test("the running CI process itself obeys the provider sandbox fence", () => {
  assertProviderTestSandboxEnvironment(process.env);
});
