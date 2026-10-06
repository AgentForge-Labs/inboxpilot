import type { ProviderConnectionContext } from "../provider-adapter.js";
import {
  JMAP_CORE_CAPABILITY,
  JMAP_MAIL_CAPABILITY,
  type JmapConnectionConfig,
  type JmapCredentialStore,
  type JmapSession,
} from "./jmap-types.js";

export class JmapApiError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    message: string,
  ) {
    super(message);
    this.name = "JmapApiError";
  }
}

export class JmapMethodError extends Error {
  constructor(
    readonly type: string,
    readonly methodName: string,
    readonly description?: string,
  ) {
    super(
      `JMAP ${methodName} failed with ${type}${description ? `: ${description}` : ""}`,
    );
    this.name = "JmapMethodError";
  }
}

type MethodResponseTuple = [
  string,
  Record<string, unknown>,
  string,
];

export class JmapClient {
  constructor(
    private readonly config: JmapConnectionConfig,
    private readonly credentialStore: JmapCredentialStore,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async token(context: ProviderConnectionContext): Promise<string> {
    const credentials = await this.credentialStore.get(context);
    if (!credentials?.accessToken) {
      throw new Error("JMAP access token is not configured");
    }
    return credentials.accessToken;
  }

  async removeCredentials(
    context: ProviderConnectionContext,
  ): Promise<void> {
    await this.credentialStore.delete(context);
  }

  async discoverSession(
    context: ProviderConnectionContext,
  ): Promise<JmapSession> {
    const token = await this.token(context);
    const response = await this.fetchImpl(this.config.sessionUrl, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new JmapApiError(
        response.status,
        this.config.sessionUrl,
        `JMAP session discovery failed (${response.status}): ${body.slice(0, 500)}`,
      );
    }

    const session = (await response.json()) as JmapSession;
    if (!session.apiUrl || !session.accounts || !session.primaryAccounts) {
      throw new TypeError("Invalid JMAP session document");
    }
    if (!session.capabilities?.[JMAP_CORE_CAPABILITY]) {
      throw new TypeError("JMAP server does not advertise core capability");
    }
    if (!session.capabilities?.[JMAP_MAIL_CAPABILITY]) {
      throw new TypeError("JMAP server does not advertise mail capability");
    }
    if (!session.primaryAccounts[JMAP_MAIL_CAPABILITY]) {
      throw new TypeError("JMAP session has no primary mail account");
    }
    return session;
  }

  async invoke<T extends object>(
    context: ProviderConnectionContext,
    session: JmapSession,
    methodName: string,
    argumentsObject: Record<string, unknown>,
    callId = "c1",
  ): Promise<T> {
    const token = await this.token(context);
    const response = await this.fetchImpl(session.apiUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        using: [JMAP_CORE_CAPABILITY, JMAP_MAIL_CAPABILITY],
        methodCalls: [[methodName, argumentsObject, callId]],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new JmapApiError(
        response.status,
        session.apiUrl,
        `JMAP API request failed (${response.status}): ${body.slice(0, 500)}`,
      );
    }

    const payload = (await response.json()) as {
      methodResponses?: MethodResponseTuple[];
    };
    const result = payload.methodResponses?.find(
      (entry) => entry[2] === callId,
    );
    if (!result) {
      throw new TypeError(`JMAP response is missing call id "${callId}"`);
    }

    if (result[0] === "error") {
      const error = result[1] as {
        type?: string;
        description?: string;
      };
      throw new JmapMethodError(
        error.type ?? "unknown",
        methodName,
        error.description,
      );
    }

    if (result[0] !== methodName) {
      throw new TypeError(
        `Unexpected JMAP method response "${result[0]}" for "${methodName}"`,
      );
    }
    return result[1] as T;
  }
}
