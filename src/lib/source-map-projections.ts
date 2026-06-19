import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { EventIndexInput, TelemetryEnvelope } from "./event-store.ts";

const MAX_PROJECTED_SOURCE_MAP_SOURCES = 200;
const MAX_SOURCE_MAP_STRING = 500;
const MAX_SOURCE_MAP_ERROR = 240;
const SOURCE_MAP_ROOT_KEYS = [
  "source_map_id",
  "source_map_artifact_id",
  "source_map_path",
  "javascript_artifact_id",
  "javascript_path",
  "linked_by",
  "file",
  "sourceRoot",
  "source_root",
  "version",
  "validation_status",
  "validation_error",
  "source_count",
  "section_count",
  "names_count",
  "mappings_length",
  "has_sources_content",
  "sources",
  "sections",
  "sourcesContent",
  "names",
  "mappings",
  "raw_json",
  "source_storage_policy",
  "projected_source_limit",
] as const;
const SAFE_VALIDATION_ERRORS = new Set([
  "source map exceeds bounded parser size",
  "source map could not be read",
  "source map JSON is invalid",
  "source map root must be an object",
  "source map version must be 3",
  "source map sources must be an array",
  "source map mappings must be a string",
]);

export interface SourceMapProjectionSource {
  ordinal: number;
  source_path: string | null;
  has_content: boolean;
  content_hash: string | null;
}

export function sanitizeSourceMapTelemetry(
  value: unknown,
): Record<string, unknown> | null {
  const sourceMap = objectRecord(value);
  if (Object.keys(sourceMap).length === 0) return null;
  if (!hasSourceMapTelemetrySignal(sourceMap)) return null;

  const sources = sanitizedSources(sourceMap);
  const rawSources = Array.isArray(sourceMap.sources) ? sourceMap.sources : [];
  const rawSourcesContent = Array.isArray(sourceMap.sourcesContent)
    ? sourceMap.sourcesContent
    : [];
  const rawNames = Array.isArray(sourceMap.names) ? sourceMap.names : [];
  const rawMappings =
    typeof sourceMap.mappings === "string" ? sourceMap.mappings : null;
  const sourceCount = integerValue(sourceMap.source_count) ?? rawSources.length;
  const hasSourcesContent =
    booleanValue(sourceMap.has_sources_content) ??
    (rawSourcesContent.some((content) => typeof content === "string") ||
      sources.rows.some((source) => source.has_content));
  const validation =
    validationStatus(sourceMap.validation_status) ??
    (integerValue(sourceMap.version) === 3 &&
    Array.isArray(sourceMap.sources) &&
    typeof sourceMap.mappings === "string"
      ? "parsed"
      : null);
  const sanitized = compactObject({
    source_map_id: sanitizeSourceMapIdentifierValue(sourceMap.source_map_id),
    source_map_artifact_id: sanitizeSourceMapIdentifierValue(
      sourceMap.source_map_artifact_id,
    ),
    source_map_path: sanitizeSourceMapPathValue(sourceMap.source_map_path),
    javascript_artifact_id: sanitizeSourceMapIdentifierValue(
      sourceMap.javascript_artifact_id,
    ),
    javascript_path: sanitizeSourceMapPathValue(sourceMap.javascript_path),
    linked_by: linkedBy(sourceMap.linked_by),
    file: sanitizeSourceMapPathValue(sourceMap.file),
    source_root: sanitizeSourceMapPathValue(
      sourceMap.source_root ?? sourceMap.sourceRoot,
    ),
    version: integerValue(sourceMap.version),
    validation_status: validation,
    validation_error: sanitizeSourceMapValidationError(
      sourceMap.validation_error,
    ),
    source_count: sourceCount,
    section_count: Array.isArray(sourceMap.sections)
      ? sourceMap.sections.length
      : integerValue(sourceMap.section_count),
    names_count: integerValue(sourceMap.names_count) ?? rawNames.length,
    mappings_length:
      integerValue(sourceMap.mappings_length) ?? rawMappings?.length,
    has_sources_content: hasSourcesContent,
    sources: sources.rows,
    truncated:
      booleanValue(sourceMap.truncated) ??
      sources.truncated ??
      rawSources.length > MAX_PROJECTED_SOURCE_MAP_SOURCES,
    content_hash: sanitizeSourceMapContentHashValue(sourceMap.content_hash),
    size_bytes: integerValue(sourceMap.size_bytes),
    source_storage_policy: "paths_and_hashes_only",
    projected_source_limit: MAX_PROJECTED_SOURCE_MAP_SOURCES,
  });

  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

export function sanitizeSourceMapArtifactRecord(
  value: unknown,
): Record<string, unknown> {
  const artifact = objectRecord(value);
  if (Object.keys(artifact).length === 0) return {};

  const artifactType =
    stringValue(artifact.artifact_type) ?? stringValue(artifact.type);
  const path = stringValue(artifact.path);
  const isSourceMapArtifact =
    artifactType === "source_map" ||
    artifactType === "source-map" ||
    artifactType === "sourcemap" ||
    Boolean(path?.endsWith(".map")) ||
    hasSourceMapTelemetrySignal(artifact);
  const nested = sanitizeSourceMapTelemetry(artifact.source_map);
  const root = isSourceMapArtifact
    ? sanitizeSourceMapTelemetry(artifact)
    : null;
  const sourceMap = nested ?? root;
  const output = isSourceMapArtifact
    ? sourceMapArtifactOutput(artifact)
    : { ...artifact };

  if (isSourceMapArtifact) {
    for (const key of SOURCE_MAP_ROOT_KEYS) output[key] = undefined;
    if ("path" in output) output.path = sanitizeSourceMapPathValue(output.path);
  }
  if (sourceMap) output.source_map = sourceMap;
  else if ("source_map" in output) output.source_map = undefined;

  return output;
}

function sourceMapArtifactOutput(
  artifact: Record<string, unknown>,
): Record<string, unknown> {
  const artifactType =
    sourceMapArtifactKind(artifact.artifact_type) ??
    sourceMapArtifactKind(artifact.type) ??
    "source_map";
  return compactObject({
    category: sanitizeSourceMapScalarValue("category", artifact.category),
    scanner: sanitizeSourceMapScalarValue("scanner", artifact.scanner),
    run_type: sanitizeSourceMapScalarValue("run_type", artifact.run_type),
    tool: sanitizeSourceMapScalarValue("tool", artifact.tool),
    package_manager: sanitizeSourceMapScalarValue(
      "package_manager",
      artifact.package_manager,
    ),
    framework: sanitizeSourceMapScalarValue("framework", artifact.framework),
    script: sanitizeSourceMapScalarValue("script", artifact.script),
    artifact_id: sanitizeSourceMapIdentifierValue(artifact.artifact_id),
    artifact_type: artifactType,
    type:
      sourceMapArtifactKind(artifact.type) ??
      sanitizeSourceMapScalarValue("type", artifact.type),
    path: sanitizeSourceMapPathValue(artifact.path),
    content_hash: sanitizeSourceMapContentHashValue(artifact.content_hash),
    size_bytes: integerValue(artifact.size_bytes),
    changed: sanitizeSourceMapScalarValue("changed", artifact.changed),
    mtime_ms: numberValue(artifact.mtime_ms),
    truncated: booleanValue(artifact.truncated),
  });
}

export function sanitizeSourceMapPathValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.split("\\").join("/");
  if (!normalized || normalized.includes("\0")) return null;
  if (normalized.startsWith("[source-map-")) {
    if (
      /^\[source-map-(host_path|unsafe_relative|unsafe_marker):[a-f0-9]{16}\]$/.test(
        normalized,
      )
    )
      return normalized;
    return pathHashMarker("unsafe_marker", normalized);
  }
  if (isHostPathLike(normalized))
    return pathHashMarker("host_path", normalized);

  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return pathHashMarker("unsafe_relative", normalized);
    parts.push(part);
  }
  if (parts.length === 0) return null;
  return truncatedString(parts.join("/"), MAX_SOURCE_MAP_STRING);
}

export function sanitizeSourceMapIdentifierValue(
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.split("\\").join("/");
  if (!normalized || normalized.includes("\0")) return null;
  if (normalized.startsWith("[source-map-")) {
    if (/^\[source-map-id:[a-f0-9]{16}\]$/.test(normalized)) return normalized;
    return identifierHashMarker(normalized);
  }
  if (
    isHostPathLike(normalized) ||
    normalized.includes("/") ||
    normalized.includes("..") ||
    /\s/.test(normalized)
  )
    return identifierHashMarker(normalized);
  return truncatedString(normalized, MAX_SOURCE_MAP_STRING);
}

export function sourceMapFallbackIdentifier(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return identifierHashMarker(`fallback:${text ?? String(value)}`);
}

export function sanitizeSourceMapContextRecord(
  value: unknown,
): Record<string, unknown> {
  const record = objectRecord(value);
  const output = { ...record };
  sanitizeContextId(output, "artifact_id");
  sanitizeContextId(output, "source_map_id");
  sanitizeContextId(output, "source_map_artifact_id");
  sanitizeContextId(output, "javascript_artifact_id");
  sanitizeContextPath(output, "path");
  sanitizeContextPath(output, "source_map_path");
  sanitizeContextPath(output, "javascript_path");
  sanitizeContextPath(output, "file");
  sanitizeContextPath(output, "sourceRoot");
  sanitizeContextPath(output, "source_root");
  sanitizeContextContentHash(output, "content_hash");
  sanitizeContextArtifactType(output, "artifact_type");
  sanitizeContextArtifactType(output, "type");
  sanitizeContextScalar(output, "category", "category");
  sanitizeContextScalar(output, "scanner", "scanner");
  sanitizeContextScalar(output, "run_type", "run_type");
  sanitizeContextScalar(output, "tool", "tool");
  sanitizeContextScalar(output, "package_manager", "package_manager");
  sanitizeContextScalar(output, "framework", "framework");
  sanitizeContextScalar(output, "script", "script");
  sanitizeContextScalar(output, "changed", "changed");
  return output;
}

export function sourceMapSourceRowId(
  sourceMapId: string,
  ordinal: number,
): string {
  return `srcmap_source_${createHash("md5")
    .update(sourceMapId)
    .update(":")
    .update(String(ordinal))
    .digest("hex")}`;
}

export function upsertSourceMapProjection(
  db: Database,
  event: TelemetryEnvelope,
  index: EventIndexInput,
): void {
  const sourceMap = sourceMapObject(event, index);
  if (!sourceMap) return;

  const body = objectRecord(event.body);
  const rootArtifact = sanitizeSourceMapArtifactRecord(body);
  const artifact = compactObject({
    ...rootArtifact,
    ...objectRecord(event.body?.artifact),
  });
  const attrs = objectRecord(event.attributes);
  const metadata = objectRecord(index.metadata);
  const sourceMapIdCandidate =
    firstString(
      [sourceMap, artifact, attrs, metadata],
      ["source_map_id", "source_map_artifact_id", "artifact_id"],
    ) ?? index.artifact_id;
  const sourceMapId =
    sanitizeSourceMapIdentifierValue(sourceMapIdCandidate) ??
    sourceMapFallbackIdentifier(event.event_id);
  const sourceMapArtifactId =
    sanitizeSourceMapIdentifierValue(
      firstString(
        [sourceMap, artifact, attrs, metadata],
        ["source_map_artifact_id", "artifact_id"],
      ) ?? sourceMapId,
    ) ?? sourceMapId;
  const sourceMapPath = sanitizeSourceMapPathValue(
    firstString(
      [sourceMap, artifact, attrs, metadata],
      ["source_map_path", "path"],
    ),
  );
  const javascriptArtifactId = sanitizeSourceMapIdentifierValue(
    sourceMap.javascript_artifact_id,
  );
  const contentHash =
    sanitizeSourceMapContentHashValue(sourceMap.content_hash) ??
    sanitizeSourceMapContentHashValue(artifact.content_hash) ??
    sanitizeSourceMapContentHashValue(attrs.content_hash);
  const sources = projectedSources(sourceMap);
  const sourceCount =
    integerValue(sourceMap.source_count) ??
    sources.total_count ??
    sources.rows.length;
  const namesCount = integerValue(sourceMap.names_count);
  const mappingsLength = integerValue(sourceMap.mappings_length);
  const hasSourcesContent =
    booleanValue(sourceMap.has_sources_content) ??
    sources.rows.some((source) => source.has_content);
  const truncated =
    booleanValue(sourceMap.truncated) ??
    sources.truncated ??
    sources.rows.length < sourceCount;

  const projectionMetadata = compactObject({
    category: "source_map",
    source_map_artifact_id: sourceMapArtifactId,
    javascript_artifact_id: javascriptArtifactId,
    source_map_path: sourceMapPath,
    javascript_path: stringValue(sourceMap.javascript_path),
    source_root: stringValue(sourceMap.source_root),
    file: stringValue(sourceMap.file),
    version: integerValue(sourceMap.version),
    validation_status: validationStatus(sourceMap.validation_status),
    validation_error: sanitizeSourceMapValidationError(
      sourceMap.validation_error,
    ),
    source_count: sourceCount,
    names_count: namesCount,
    mappings_length: mappingsLength,
    has_sources_content: hasSourcesContent,
    truncated,
    content_hash: contentHash,
    size_bytes:
      integerValue(sourceMap.size_bytes) ??
      integerValue(artifact.size_bytes) ??
      integerValue(attrs.size_bytes),
    source_storage_policy: "paths_and_hashes_only",
    projected_source_limit: MAX_PROJECTED_SOURCE_MAP_SOURCES,
  });

  db.prepare(`
    INSERT INTO source_maps (
      id, event_id, project_id, machine_id, repo_id, app_id, process_id, run_id,
      environment, source_map_artifact_id, javascript_artifact_id, source_map_path,
      javascript_path, source_root, file, version, validation_status, validation_error,
      source_count, names_count, mappings_length, has_sources_content, truncated,
      content_hash, size_bytes, metadata
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      event_id = COALESCE(excluded.event_id, source_maps.event_id),
      project_id = COALESCE(excluded.project_id, source_maps.project_id),
      machine_id = COALESCE(excluded.machine_id, source_maps.machine_id),
      repo_id = COALESCE(excluded.repo_id, source_maps.repo_id),
      app_id = COALESCE(excluded.app_id, source_maps.app_id),
      process_id = COALESCE(excluded.process_id, source_maps.process_id),
      run_id = COALESCE(excluded.run_id, source_maps.run_id),
      environment = COALESCE(excluded.environment, source_maps.environment),
      source_map_artifact_id = COALESCE(excluded.source_map_artifact_id, source_maps.source_map_artifact_id),
      javascript_artifact_id = excluded.javascript_artifact_id,
      source_map_path = COALESCE(excluded.source_map_path, source_maps.source_map_path),
      javascript_path = excluded.javascript_path,
      source_root = excluded.source_root,
      file = excluded.file,
      version = excluded.version,
      validation_status = excluded.validation_status,
      validation_error = excluded.validation_error,
      source_count = excluded.source_count,
      names_count = excluded.names_count,
      mappings_length = excluded.mappings_length,
      has_sources_content = excluded.has_sources_content,
      truncated = excluded.truncated,
      content_hash = COALESCE(excluded.content_hash, source_maps.content_hash),
      size_bytes = COALESCE(excluded.size_bytes, source_maps.size_bytes),
      metadata = excluded.metadata
  `).run(
    sourceMapId,
    event.event_id,
    index.project_id ?? null,
    index.machine_id ?? event.machine_id ?? null,
    index.repo_id ?? event.repo_id ?? null,
    index.app_id ?? event.app_id ?? null,
    index.process_id ?? event.process_id ?? null,
    index.run_id ?? event.run_id ?? null,
    index.environment ?? event.environment ?? null,
    sourceMapArtifactId,
    javascriptArtifactId,
    sourceMapPath,
    stringValue(sourceMap.javascript_path),
    stringValue(sourceMap.source_root),
    stringValue(sourceMap.file),
    integerValue(sourceMap.version),
    validationStatus(sourceMap.validation_status),
    sanitizeSourceMapValidationError(sourceMap.validation_error),
    sourceCount,
    namesCount,
    mappingsLength,
    hasSourcesContent ? 1 : 0,
    truncated ? 1 : 0,
    contentHash,
    integerValue(sourceMap.size_bytes) ??
      integerValue(artifact.size_bytes) ??
      integerValue(attrs.size_bytes),
    JSON.stringify(projectionMetadata),
  );

  db.prepare("DELETE FROM source_map_sources WHERE source_map_id = ?").run(
    sourceMapId,
  );
  const insertSource = db.prepare(`
    INSERT INTO source_map_sources (
      id, source_map_id, ordinal, source_path, has_content, content_hash, metadata
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const source of sources.rows) {
    insertSource.run(
      sourceMapSourceRowId(sourceMapId, source.ordinal),
      sourceMapId,
      source.ordinal,
      source.source_path,
      source.has_content ? 1 : 0,
      source.content_hash,
      JSON.stringify({
        source_storage_policy: "paths_and_hashes_only",
        truncated: sources.truncated,
      }),
    );
  }
}

function sourceMapObject(
  event: TelemetryEnvelope,
  index: EventIndexInput,
): Record<string, unknown> | null {
  const body = objectRecord(event.body);
  const artifact = objectRecord(body.artifact);
  const attrs = objectRecord(event.attributes);
  const metadata = objectRecord(index.metadata);
  const sanitizedRootArtifact = sanitizeSourceMapArtifactRecord(body);
  const sanitizedArtifact = sanitizeSourceMapArtifactRecord(artifact);
  const sanitizedAttrs = sanitizeSourceMapArtifactRecord(attrs);
  const candidates = [
    objectRecord(artifact.source_map),
    objectRecord(body.source_map),
    objectRecord(attrs.source_map),
    objectRecord(metadata.source_map),
    objectRecord(sanitizedRootArtifact.source_map),
    objectRecord(sanitizedArtifact.source_map),
    objectRecord(sanitizedAttrs.source_map),
  ];
  const sourceMap =
    candidates.find((candidate) => Object.keys(candidate).length > 0) ?? null;
  return sanitizeSourceMapTelemetry(sourceMap);
}

function projectedSources(sourceMap: Record<string, unknown>): {
  rows: SourceMapProjectionSource[];
  total_count: number | null;
  truncated: boolean;
} {
  const rawSources = Array.isArray(sourceMap.sources) ? sourceMap.sources : [];
  const rows: SourceMapProjectionSource[] = [];
  const usedOrdinals = new Set<number>();
  let nextOrdinal = 0;
  for (const [index, raw] of rawSources.entries()) {
    if (rows.length >= MAX_PROJECTED_SOURCE_MAP_SOURCES) break;
    const source = objectRecord(raw);
    if (Object.keys(source).length === 0) continue;
    let ordinal = integerValue(source.ordinal) ?? index;
    if (ordinal < 0) ordinal = index;
    while (usedOrdinals.has(ordinal)) ordinal = nextOrdinal++;
    usedOrdinals.add(ordinal);
    nextOrdinal = Math.max(nextOrdinal, ordinal + 1);
    rows.push({
      ordinal,
      source_path: sanitizeSourceMapPathValue(source.source_path),
      has_content: booleanValue(source.has_content) ?? false,
      content_hash: sanitizeSourceMapContentHashValue(source.content_hash),
    });
  }
  const totalCount = integerValue(sourceMap.source_count);
  return {
    rows,
    total_count: totalCount,
    truncated:
      booleanValue(sourceMap.truncated) ??
      rawSources.length > MAX_PROJECTED_SOURCE_MAP_SOURCES,
  };
}

function sanitizedSources(sourceMap: Record<string, unknown>): {
  rows: SourceMapProjectionSource[];
  truncated: boolean;
} {
  const rawSources = Array.isArray(sourceMap.sources) ? sourceMap.sources : [];
  const rawSourcesContent = Array.isArray(sourceMap.sourcesContent)
    ? sourceMap.sourcesContent
    : [];
  const rows: SourceMapProjectionSource[] = [];
  const usedOrdinals = new Set<number>();
  let nextOrdinal = 0;
  for (const [index, raw] of rawSources.entries()) {
    if (rows.length >= MAX_PROJECTED_SOURCE_MAP_SOURCES) break;
    const source = objectRecord(raw);
    const content =
      rawSourcesContent[index] ??
      (typeof source.content === "string" ? source.content : undefined);
    let ordinal = integerValue(source.ordinal) ?? index;
    if (ordinal < 0) ordinal = index;
    while (usedOrdinals.has(ordinal)) ordinal = nextOrdinal++;
    usedOrdinals.add(ordinal);
    nextOrdinal = Math.max(nextOrdinal, ordinal + 1);
    const computedContentHash =
      typeof content === "string"
        ? createHash("sha256").update(content).digest("hex")
        : null;
    rows.push({
      ordinal,
      source_path: sanitizeSourceMapPathValue(
        typeof raw === "string"
          ? raw
          : (source.source_path ?? source.path ?? source.source),
      ),
      has_content:
        booleanValue(source.has_content) ?? typeof content === "string",
      content_hash:
        computedContentHash ??
        sanitizeSourceMapContentHashValue(source.content_hash),
    });
  }
  return {
    rows,
    truncated: rawSources.length > MAX_PROJECTED_SOURCE_MAP_SOURCES,
  };
}

function validationStatus(value: unknown): string | null {
  const status = stringValue(value);
  if (
    status === "parsed" ||
    status === "malformed" ||
    status === "too_large" ||
    status === "unsupported"
  )
    return status;
  return null;
}

function linkedBy(value: unknown): string | null {
  const linked = stringValue(value);
  if (
    linked === "adjacent_path" ||
    linked === "file_field" ||
    linked === "none"
  )
    return linked;
  return null;
}

function hasSourceMapTelemetrySignal(
  sourceMap: Record<string, unknown>,
): boolean {
  const artifactType =
    stringValue(sourceMap.artifact_type) ?? stringValue(sourceMap.type);
  const path = stringValue(sourceMap.path);
  if (
    artifactType === "source_map" ||
    artifactType === "source-map" ||
    artifactType === "sourcemap" ||
    Boolean(path?.endsWith(".map"))
  )
    return true;

  for (const key of SOURCE_MAP_ROOT_KEYS) {
    if (key === "source_storage_policy" || key === "projected_source_limit")
      continue;
    const value = sourceMap[key];
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) return true;
      continue;
    }
    if (typeof value === "string") {
      if (value.length > 0) return true;
      continue;
    }
    if (typeof value === "boolean") {
      if (value) return true;
      continue;
    }
    return true;
  }

  return false;
}

function sanitizeSourceMapValidationError(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (
    SAFE_VALIDATION_ERRORS.has(value) ||
    /^\[source-map-validation-error:[a-f0-9]{16}\]$/.test(value)
  )
    return truncatedString(value, MAX_SOURCE_MAP_ERROR);
  return `[source-map-validation-error:${createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 16)}]`;
}

function firstString(
  records: Record<string, unknown>[],
  keys: string[],
): string | null {
  for (const key of keys) {
    for (const record of records) {
      const value = stringValue(record[key]);
      if (value) return value;
    }
  }
  return null;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return truncatedString(value, MAX_SOURCE_MAP_STRING);
}

function truncatedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}... [truncated]`;
}

function integerValue(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function isHostPathLike(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("~/") ||
    value.startsWith("//") ||
    /^[a-zA-Z]:\//.test(value) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)
  );
}

function pathHashMarker(kind: string, value: string): string {
  return `[source-map-${kind}:${createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 16)}]`;
}

function identifierHashMarker(value: string): string {
  return `[source-map-id:${createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 16)}]`;
}

function scalarHashMarker(value: string): string {
  return `[source-map-scalar:${createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 16)}]`;
}

const SOURCE_MAP_SCALAR_ALLOWLISTS: Record<string, Set<string>> = {
  category: new Set(["build_artifact", "source_map"]),
  scanner: new Set(["common-output-roots"]),
  run_type: new Set(["command", "build", "test", "dev-server"]),
  tool: new Set([
    "ava",
    "biome",
    "build",
    "eslint",
    "jest",
    "mocha",
    "next",
    "playwright",
    "rollup",
    "svelte-kit",
    "test",
    "tsc",
    "turbo",
    "vite",
    "vitest",
    "webpack",
  ]),
  package_manager: new Set(["bun", "npm", "pnpm", "yarn"]),
  framework: new Set(["astro", "next", "nuxt", "remix", "svelte-kit", "vite"]),
  script: new Set([
    "build",
    "check",
    "dev",
    "lint",
    "serve",
    "start",
    "test",
    "typecheck",
  ]),
  type: new Set(["source_map"]),
  changed: new Set(["created", "modified"]),
};

function sanitizeSourceMapScalarValue(
  field: keyof typeof SOURCE_MAP_SCALAR_ALLOWLISTS,
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().split("\\").join("/");
  if (!normalized || normalized.includes("\0")) return null;
  if (normalized.startsWith("[source-map-")) {
    if (/^\[source-map-scalar:[a-f0-9]{16}\]$/.test(normalized))
      return normalized;
    return scalarHashMarker(normalized);
  }
  if (SOURCE_MAP_SCALAR_ALLOWLISTS[field]?.has(normalized)) return normalized;
  if (
    isHostPathLike(normalized) ||
    normalized.includes("/") ||
    normalized.includes("..") ||
    /\s/.test(normalized) ||
    !/^[a-zA-Z0-9_.-]+$/.test(normalized)
  )
    return scalarHashMarker(normalized);
  return scalarHashMarker(normalized);
}

function sourceMapArtifactKind(value: unknown): "source_map" | null {
  const kind = stringValue(value);
  if (kind === "source_map" || kind === "source-map" || kind === "sourcemap") {
    return "source_map";
  }
  return null;
}

function sanitizeSourceMapContentHashValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.includes("\0")) return null;
  if (/^\[source-map-content-hash:[a-f0-9]{16}\]$/.test(normalized)) {
    return normalized;
  }
  if (/^[a-f0-9]{64}$/i.test(normalized)) return normalized.toLowerCase();
  if (/^sha256:[a-f0-9]{64}$/i.test(normalized)) {
    return normalized.toLowerCase();
  }
  return `[source-map-content-hash:${createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 16)}]`;
}

function sanitizeContextId(record: Record<string, unknown>, key: string): void {
  if (!(key in record)) return;
  const value = sanitizeSourceMapIdentifierValue(record[key]);
  if (value) record[key] = value;
  else record[key] = undefined;
}

function sanitizeContextPath(
  record: Record<string, unknown>,
  key: string,
): void {
  if (!(key in record)) return;
  const value = sanitizeSourceMapPathValue(record[key]);
  if (value) record[key] = value;
  else record[key] = undefined;
}

function sanitizeContextContentHash(
  record: Record<string, unknown>,
  key: string,
): void {
  if (!(key in record)) return;
  const value = sanitizeSourceMapContentHashValue(record[key]);
  if (value) record[key] = value;
  else record[key] = undefined;
}

function sanitizeContextArtifactType(
  record: Record<string, unknown>,
  key: string,
): void {
  if (!(key in record)) return;
  const value = sourceMapArtifactKind(record[key]);
  if (value) record[key] = value;
  else record[key] = undefined;
}

function sanitizeContextScalar(
  record: Record<string, unknown>,
  key: string,
  field: keyof typeof SOURCE_MAP_SCALAR_ALLOWLISTS,
): void {
  if (!(key in record)) return;
  const value = sanitizeSourceMapScalarValue(field, record[key]);
  if (value) record[key] = value;
  else record[key] = undefined;
}

function compactObject(
  input: Record<string, unknown | null | undefined>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== null && value !== undefined) output[key] = value;
  }
  return output;
}
