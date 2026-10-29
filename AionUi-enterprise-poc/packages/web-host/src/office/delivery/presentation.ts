import { createHash } from "node:crypto";
import type { VerifiedSourceEvidence } from "../source-evidence.js";

export type OfficeSource = {
  id: string;
  title: string;
  version: string;
  location: string;
  url?: string;
  originalUrl?: string;
  quotes: string[];
};
export type OfficeMetric = {
  object: string;
  parameter: string;
  unit: string;
  value?: number | null;
  calculation?: { operation: "sum" | "difference" | "ratio"; rows: number[] };
};
export type OfficeFinding = {
  topic: string;
  source: string;
  requirement?: string;
  assessment: string;
  analysis: string;
  missing: string;
  metric?: OfficeMetric;
};
export type OfficeReport = {
  purpose: "research" | "compliance";
  scope: string;
  conclusion: string;
  findings: OfficeFinding[];
};
export type OfficeSection = { heading: string; paragraphs: string[] };
export type OfficeProvenance = {
  schemaVersion: 1;
  dataSha256?: string;
  sources: VerifiedSourceEvidence[];
  revisions?: unknown[];
};

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Only non-credential URLs may be placed in downloadable Office relationships. */
export function safeOfficeSourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    if (
      [...url.searchParams.keys()].some((key) =>
        /^(?:access_?token|refresh_?token|token|cookie|authorization|password|secret|api_?key|signature|sign)$/i.test(
          key,
        ),
      )
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}

function locationText(value: unknown): string {
  if (typeof value === "string") return value;
  const location = object(value);
  if (location.kind === "worksheet")
    return [
      location.name || (location.worksheet ? `工作表 ${location.worksheet}` : ""),
      location.range,
    ]
      .filter(Boolean)
      .join(" · ");
  if (location.kind === "text_chunk" && Number.isInteger(location.lineStart) && Number.isInteger(location.lineEnd))
    return `第 ${location.lineStart}–${location.lineEnd} 行`;
  if (location.kind === "web_excerpt" && Number.isInteger(location.start) && Number.isInteger(location.end))
    return `网页正文字符 ${location.start}–${location.end}`;
  if (location.page) return `第 ${location.page} 页`;
  if (location.paragraph) return `段落 ${location.paragraph}`;
  if (location.table) return `表格 ${location.table}`;
  return "未提供位置";
}

/** Deduplicate readable references while retaining exact internal evidence outside body content. */
export function buildOfficeSources(sources: VerifiedSourceEvidence[]) {
  const entries: OfficeSource[] = [],
    numbers: string[] = [];
  const known = new Map<string, OfficeSource>();
  for (const source of sources) {
    const locator = object(source.locator);
    // Secret fields are never valid provenance, including hidden Office parts.
    if (
      /"(?:password|cookie|authorization|access_token|refresh_token|apiKey|secret)"\s*:/i.test(
        JSON.stringify(locator),
      )
    )
      throw new Error("OFFICE_SOURCE_SECRET_METADATA_REJECTED");
    for (const key of ["sourceUrl", "url", "downloadUrl", "originalUrl"]) {
      if (typeof locator[key] !== "string") continue;
      try {
        const url = new URL(locator[key]);
        if (
          url.username ||
          url.password ||
          [...url.searchParams.keys()].some((key) =>
            /^(?:access_?token|refresh_?token|token|cookie|authorization|password|secret|api_?key|signature|sign)$/i.test(
              key,
            ),
          )
        )
          throw new Error("OFFICE_SOURCE_CREDENTIAL_URL_REJECTED");
      } catch (error) {
        if ((error as Error).message === "OFFICE_SOURCE_CREDENTIAL_URL_REJECTED") throw error;
      }
    }
    const { retrievedAt: _retrievedAt, ...stableLocator } = locator;
    const identity = createHash("sha256")
      .update(JSON.stringify(stable({ kind: source.kind, locator: stableLocator })))
      .digest("hex");
    let entry = known.get(identity);
    if (!entry) {
      const rawPath =
        typeof locator.path === "string"
          ? locator.path.replaceAll("\\", "/").split("/").at(-1)
          : undefined;
      entry = {
        id: `S${entries.length + 1}`,
        title: String(
          locator.title || rawPath || (source.kind === "web" ? "公开网页" : "来源资料"),
        ),
        version: String(
          locator.versionLabel ||
            (locator.version == null
              ? locator.sha256
                ? "读取时版本"
                : "未提供版本"
              : `v${locator.version}`),
        ),
        location: locationText(locator.location),
        url: safeOfficeSourceUrl(locator.sourceUrl || locator.url || locator.downloadUrl),
        originalUrl: safeOfficeSourceUrl(locator.originalUrl),
        quotes: [],
      };
      entries.push(entry);
      known.set(identity, entry);
    }
    if (!entry.quotes.includes(source.quote)) entry.quotes.push(source.quote);
    numbers.push(entry.id);
  }
  return {
    entries,
    numbers,
    provenance: { schemaVersion: 1 as const, sources: structuredClone(sources) },
  };
}
