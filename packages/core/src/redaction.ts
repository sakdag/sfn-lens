const DEFAULT_KEY_PATTERN =
  /^(password|passwd|secret|ssn|email|phone|address|creditcard|credit_card|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key)$/i;

export interface RedactionOptions {
  /** Extra JSONPath-like paths, e.g. "$.customer.ssn" or "customer.ssn". */
  jsonPaths?: string[];
  /** Additional exact key names to redact (case-insensitive). */
  extraKeys?: string[];
}

/**
 * Deep-clone and redact sensitive fields before model or UI exposure.
 * Supports simple JSONPath (`$.a.b`, `a.b`, `$.items[*].ssn`) and key-name matching.
 */
export function redactValue(value: unknown, options: RedactionOptions = {}): unknown {
  const paths = normalizePaths([
    ...(options.jsonPaths ?? parseEnvPaths(process.env.SFN_LENS_REDACT_JSONPATHS)),
    ...(options.extraKeys ?? []).map((k) => `$..${k}`),
  ]);
  return walk(value, "$", paths, new Set(options.extraKeys?.map((k) => k.toLowerCase()) ?? []));
}

function parseEnvPaths(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw.split(/[,;\s]+/).filter(Boolean);
}

function normalizePaths(paths: string[]): string[] {
  return paths.map((p) => (p.startsWith("$") ? p : `$.${p}`));
}

function walk(
  value: unknown,
  path: string,
  paths: string[],
  extraKeys: Set<string>,
): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) {
    return value.map((item, i) => walk(item, `${path}[${i}]`, paths, extraKeys));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const childPath = `${path}.${k}`;
      if (shouldRedactKey(k, childPath, paths, extraKeys)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = walk(v, childPath, paths, extraKeys);
      }
    }
    return out;
  }
  return value;
}

function shouldRedactKey(
  key: string,
  fullPath: string,
  paths: string[],
  extraKeys: Set<string>,
): boolean {
  if (DEFAULT_KEY_PATTERN.test(key) || extraKeys.has(key.toLowerCase())) return true;
  for (const p of paths) {
    if (pathMatches(p, fullPath, key)) return true;
  }
  return false;
}

/** Very small matcher: exact path, or `$..key`, or `$.a.b`. */
function pathMatches(pattern: string, fullPath: string, key: string): boolean {
  if (pattern === fullPath) return true;
  if (pattern.startsWith("$..") && pattern.slice(3).toLowerCase() === key.toLowerCase()) {
    return true;
  }
  // Wildcard array: $.items[*].ssn
  const wild = pattern.replace(/\[\*\]/g, "\\[\\d+\\]").replace(/\./g, "\\.");
  try {
    return new RegExp(`^${wild}$`, "i").test(fullPath);
  } catch {
    return false;
  }
}

export function redactJsonString(raw: string | undefined, options?: RedactionOptions): unknown {
  if (raw == null || raw === "") return undefined;
  try {
    return redactValue(JSON.parse(raw), options);
  } catch {
    return raw;
  }
}
