import { resolveMx, resolveSrv } from "node:dns/promises";
import type {
  MailServiceEndpoint,
  ProviderDiscoveryResult,
} from "./onboarding-types.js";

export interface MxRecord {
  exchange: string;
  priority: number;
}

export interface SrvRecord {
  name: string;
  port: number;
  priority: number;
  weight: number;
}

export interface ProviderDiscoveryNetwork {
  resolveMx(domain: string): Promise<MxRecord[]>;
  resolveSrv(name: string): Promise<SrvRecord[]>;
}

export class NodeDnsProviderDiscoveryNetwork
  implements ProviderDiscoveryNetwork
{
  async resolveMx(domain: string): Promise<MxRecord[]> {
    return resolveMx(domain);
  }

  async resolveSrv(name: string): Promise<SrvRecord[]> {
    return resolveSrv(name);
  }
}

interface ProviderPreset {
  provider: "google" | "microsoft" | "jmap" | "imap";
  domains: readonly string[];
  jmapSessionUrl?: string;
  incoming?: MailServiceEndpoint;
  outgoing?: MailServiceEndpoint;
}

const PRESETS: readonly ProviderPreset[] = [
  {
    provider: "google",
    domains: ["gmail.com", "googlemail.com"],
  },
  {
    provider: "microsoft",
    domains: ["outlook.com", "hotmail.com", "live.com", "msn.com"],
  },
  {
    provider: "jmap",
    domains: ["fastmail.com", "fastmail.fm"],
    jmapSessionUrl: "https://api.fastmail.com/jmap/session",
  },
  {
    provider: "imap",
    domains: ["icloud.com", "me.com", "mac.com"],
    incoming: {
      protocol: "imap",
      host: "imap.mail.me.com",
      port: 993,
      tlsMode: "implicit",
      source: "preset",
    },
    outgoing: {
      protocol: "submission",
      host: "smtp.mail.me.com",
      port: 587,
      tlsMode: "starttls",
      source: "preset",
    },
  },
  {
    provider: "imap",
    domains: ["yahoo.com", "yahoo.de", "ymail.com"],
    incoming: {
      protocol: "imap",
      host: "imap.mail.yahoo.com",
      port: 993,
      tlsMode: "implicit",
      source: "preset",
    },
    outgoing: {
      protocol: "submission",
      host: "smtp.mail.yahoo.com",
      port: 465,
      tlsMode: "implicit",
      source: "preset",
    },
  },
];

function normalizeDomain(domain: string): string {
  const normalized = domain.trim().toLowerCase().replace(/\.$/, "");
  if (
    !normalized ||
    normalized.length > 253 ||
    normalized === "localhost" ||
    normalized.includes("/") ||
    normalized.includes(":") ||
    /^\d+(?:\.\d+){3}$/.test(normalized)
  ) {
    throw new TypeError("Email domain is not valid for provider discovery");
  }

  const labels = normalized.split(".");
  if (
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
    )
  ) {
    throw new TypeError("Email domain is not valid for provider discovery");
  }
  return normalized;
}

export function parseDiscoveryEmail(
  email: string,
): { email: string; domain: string } {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (
    at <= 0 ||
    at === normalized.length - 1 ||
    normalized.indexOf("@") !== at ||
    /\s/.test(normalized)
  ) {
    throw new TypeError("A valid email address is required");
  }
  return {
    email: normalized,
    domain: normalizeDomain(normalized.slice(at + 1)),
  };
}

function presetFor(domain: string): ProviderPreset | undefined {
  return PRESETS.find((preset) => preset.domains.includes(domain));
}

function mxProvider(records: MxRecord[]): "google" | "microsoft" | undefined {
  const exchanges = records.map((record) =>
    record.exchange.toLowerCase().replace(/\.$/, ""),
  );
  if (
    exchanges.some(
      (exchange) =>
        exchange.endsWith(".google.com") ||
        exchange.endsWith(".googlemail.com") ||
        exchange.includes("google.com"),
    )
  ) {
    return "google";
  }
  if (
    exchanges.some(
      (exchange) =>
        exchange.endsWith(".mail.protection.outlook.com") ||
        exchange.endsWith(".outlook.com"),
    )
  ) {
    return "microsoft";
  }
  return undefined;
}

async function safeResolveMx(
  network: ProviderDiscoveryNetwork,
  domain: string,
): Promise<MxRecord[]> {
  try {
    return await network.resolveMx(domain);
  } catch {
    return [];
  }
}

async function safeResolveSrv(
  network: ProviderDiscoveryNetwork,
  service: string,
  domain: string,
): Promise<SrvRecord[]> {
  try {
    return await network.resolveSrv(`${service}.${domain}`);
  } catch {
    return [];
  }
}

function bestSrv(records: SrvRecord[]): SrvRecord | undefined {
  return [...records].sort(
    (a, b) => a.priority - b.priority || b.weight - a.weight,
  )[0];
}

function srvEndpoint(
  record: SrvRecord | undefined,
  protocol: "imap" | "submission",
  tlsMode: "implicit" | "starttls",
): MailServiceEndpoint | undefined {
  if (!record || !record.name || record.name === ".") return undefined;
  const host = record.name.toLowerCase().replace(/\.$/, "");
  if (!host) return undefined;
  return {
    protocol,
    host,
    port: record.port,
    tlsMode,
    source: "srv",
  };
}

export async function discoverEmailProvider(
  email: string,
  network: ProviderDiscoveryNetwork = new NodeDnsProviderDiscoveryNetwork(),
): Promise<ProviderDiscoveryResult> {
  const parsed = parseDiscoveryEmail(email);
  const preset = presetFor(parsed.domain);
  if (preset) {
    return {
      email: parsed.email,
      domain: parsed.domain,
      provider: preset.provider,
      confidence: "high",
      evidence: [`preset:${parsed.domain}`],
      ...(preset.jmapSessionUrl
        ? { jmapSessionUrl: preset.jmapSessionUrl }
        : {}),
      ...(preset.incoming ? { incoming: preset.incoming } : {}),
      ...(preset.outgoing ? { outgoing: preset.outgoing } : {}),
      advancedSetupRequired:
        preset.provider === "imap" && !preset.incoming,
    };
  }

  const mx = await safeResolveMx(network, parsed.domain);
  const recognizedMx = mxProvider(mx);
  if (recognizedMx) {
    return {
      email: parsed.email,
      domain: parsed.domain,
      provider: recognizedMx,
      confidence: "high",
      evidence: [
        ...mx.map((record) => `mx:${record.exchange}`),
        `mx-provider:${recognizedMx}`,
      ],
      advancedSetupRequired: false,
    };
  }

  const [imaps, imap, submissions, submission] = await Promise.all([
    safeResolveSrv(network, "_imaps._tcp", parsed.domain),
    safeResolveSrv(network, "_imap._tcp", parsed.domain),
    safeResolveSrv(network, "_submissions._tcp", parsed.domain),
    safeResolveSrv(network, "_submission._tcp", parsed.domain),
  ]);

  const incoming =
    srvEndpoint(bestSrv(imaps), "imap", "implicit") ??
    srvEndpoint(bestSrv(imap), "imap", "starttls");
  const outgoing =
    srvEndpoint(bestSrv(submissions), "submission", "implicit") ??
    srvEndpoint(bestSrv(submission), "submission", "starttls");

  if (incoming) {
    return {
      email: parsed.email,
      domain: parsed.domain,
      provider: "imap",
      confidence: "medium",
      evidence: [
        `srv:${incoming.host}:${incoming.port}`,
        ...(outgoing ? [`srv:${outgoing.host}:${outgoing.port}`] : []),
      ],
      incoming,
      ...(outgoing ? { outgoing } : {}),
      advancedSetupRequired: false,
    };
  }

  return {
    email: parsed.email,
    domain: parsed.domain,
    provider: "unknown",
    confidence: mx.length ? "medium" : "low",
    evidence: mx.map((record) => `mx:${record.exchange}`),
    advancedSetupRequired: true,
  };
}
