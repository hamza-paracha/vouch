/** Redact values before serialization so quotes/backslashes in secrets cannot corrupt JSON. */
export function redact<T>(value: T): T {
  const secrets = [process.env.TYPESAFE_API_KEY, process.env.OPENROUTER_API_KEY].filter((s): s is string => !!s);
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
