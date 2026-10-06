import { GmailApiError } from "../providers/gmail/gmail-api-client.js";
import {
  MicrosoftGraphApiError,
} from "../providers/microsoft-graph/graph-api-client.js";
import {
  MicrosoftReauthorizationRequiredError,
} from "../providers/microsoft-graph/graph-oauth.js";
import {
  JmapApiError,
  JmapMethodError,
} from "../providers/jmap/jmap-client.js";
import {
  ProviderCapabilityError,
  ProviderNotConnectedError,
} from "../providers/provider-errors.js";
import type { MutationFailure } from "./action-store.js";
import type { CanonicalMutation } from "./action-types.js";
import type { ProviderKind } from "../domain/email-model.js";

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

export function classifyMutationError(error: unknown): MutationFailure {
  if (error instanceof ProviderCapabilityError) {
    return {
      category: "permanent",
      code: error.code,
      message: error.message,
    };
  }

  if (error instanceof MicrosoftReauthorizationRequiredError) {
    return {
      category: "permanent",
      code: error.code,
      message: error.message,
    };
  }

  if (error instanceof ProviderNotConnectedError) {
    return {
      category: "retryable",
      code: error.code,
      message: error.message,
    };
  }

  if (
    error instanceof GmailApiError ||
    error instanceof MicrosoftGraphApiError ||
    error instanceof JmapApiError
  ) {
    const status = error.status;
    return {
      category:
        status === 408 ||
        status === 425 ||
        status === 429 ||
        status >= 500
          ? "retryable"
          : "permanent",
      code: `HTTP_${status}`,
      message: error.message,
    };
  }

  if (error instanceof JmapMethodError) {
    const retryable = new Set([
      "serverFail",
      "serverUnavailable",
      "rateLimit",
    ]).has(error.type);
    return {
      category: retryable ? "retryable" : "permanent",
      code: `JMAP_${error.type}`,
      message: error.message,
    };
  }

  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "UNKNOWN");
    if (NETWORK_CODES.has(code)) {
      return {
        category: "uncertain",
        code,
        message: error instanceof Error ? error.message : code,
      };
    }
  }

  return {
    category: "permanent",
    code: error instanceof Error ? error.name : "UNKNOWN_ERROR",
    message: error instanceof Error ? error.message : "Unknown mutation error",
  };
}

export function isRetrySafeMutation(
  provider: ProviderKind,
  action: CanonicalMutation["type"],
): boolean {
  if (
    action === "mark_read" ||
    action === "star" ||
    action === "mark_important" ||
    action === "add_label" ||
    action === "remove_label"
  ) {
    return true;
  }

  if (
    provider === "gmail" &&
    (action === "archive" ||
      action === "move" ||
      action === "trash" ||
      action === "restore")
  ) {
    return true;
  }

  if (
    provider === "jmap" &&
    (action === "archive" ||
      action === "move" ||
      action === "trash" ||
      action === "restore")
  ) {
    return true;
  }

  return false;
}
