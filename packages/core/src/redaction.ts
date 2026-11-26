const DEFAULT_KEY_PATTERN =
  /^(password|passwd|secret|ssn|phone|address|creditcard|credit_card|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key)$/i;

/** Matches email, claimantEmail, customer_email, etc. */
const EMAIL_KEY_PATTERN = /email/i;

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

/**
 * Redact an error/cause string that may be JSON (Lambda payload) or plain text.
 * Always returns a string suitable for model/UI display.
 */
export function redactJsonString(raw: string | undefined, options?: RedactionOptions): unknown {
  if (raw == null || raw === "") return undefined;
  try {
    return redactValue(JSON.parse(raw), options);
  } catch {
    return raw;
  }
}

export function redactErrorCause(
  value: unknown,
  options: RedactionOptions = {},
): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value === "object") {
    return JSON.stringify(redactValue(value, options));
  }
  const s = String(value);
  try {
    return JSON.stringify(redactValue(JSON.parse(s), options));
  } catch {
    return scrubPlainText(s);
  }
}

function scrubPlainText(s: string): string {
  return s
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED]")
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED]");
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
  if (DEFAULT_KEY_PATTERN.test(key) || EMAIL_KEY_PATTERN.test(key)) return true;
  if (extraKeys.has(key.toLowerCase())) return true;
  for (const p of paths) {
    if (pathMatches(p, fullPath, key)) return true;
  }
  return false;
}

/** Exact path, `$..key`, or wildcard array path like `$.items[*].ssn`. */
function pathMatches(pattern: string, fullPath: string, key: string): boolean {
  if (pattern === fullPath) return true;
  if (pattern.startsWith("$..") && pattern.slice(3).toLowerCase() === key.toLowerCase()) {
    return true;
  }
  try {
    return pathPatternToRegExp(pattern).test(fullPath);
  } catch {
    return false;
  }
}

/**
 * Convert a simple JSONPath pattern to a RegExp.
 * Escapes `$` and other regex metacharacters; maps `[*]` → `\[\d+\]`.
 */
export function pathPatternToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; ) {
    if (pattern.startsWith("[*]", i)) {
      out += "\\[\\d+\\]";
      i += 3;
      continue;
    }
    const ch = pattern[i]!;
    if (/[.+?^${}()|[\]\\]/.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
    i += 1;
  }
  out += "$";
  return new RegExp(out, "i");
}
