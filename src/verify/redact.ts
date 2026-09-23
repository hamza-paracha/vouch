/** Redact values before serialization so quotes/backslashes in secrets cannot corrupt JSON. */
export function redact<T>(value: T, extraSecrets: readonly string[] = []): T {
  const secrets = [...extraSecrets, process.env.TYPESAFE_API_KEY, process.env.OPENROUTER_API_KEY].filter((s): s is string => !!s);
  function walk(item: unknown): unknown {
    if (typeof item === "string") {
      for (const secret of secrets) item = (item as string).split(secret).join("[REDACTED]");
      return (item as string).replace(/((?:authorization|password|api[_-]?key|access[_-]?token)\s*[=:]\s*)(?:Bearer\s+)?[^\s"<,}]+/gi, "$1[REDACTED]");
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, walk(v)]));
    return item;
  }
  return walk(value) as T;
}

/** Session values may be as short as "1". Scrub data without rewriting protocol enums,
 * report identities or artifact paths (which must still point to the files we write). */
export function redactBrowserEvidence<T>(value: T, secrets: readonly string[]): T {
  const metadata = new Set(["artifacts", "manifest", "cost", "limits", "runId", "startedAt", "status", "kind", "route", "role", "state", "policy", "session", "method", "category", "tier", "outcome", "requestedModel", "note"]);
  function walk(item: unknown, key = ""): unknown {
    if (metadata.has(key)) return redact(item);
    if (typeof item === "string") return redact(item, secrets);
    if (Array.isArray(item)) return item.map((entry) => walk(entry));
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, walk(v, k)]));
    return item;
  }
  return walk(value) as T;
}
