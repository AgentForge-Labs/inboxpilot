const SECRET_KEYS = /(?:token|secret|password|authorization|cookie|credential|api[_-]?key|private[_-]?key)/i;

export function redactSecrets<T>(value: T): T {
  const seen = new WeakSet<object>();

  const visit = (input: unknown, key?: string): unknown => {
    if (key && SECRET_KEYS.test(key)) return "[REDACTED]";
    if (Array.isArray(input)) return input.map((item) => visit(item));
    if (input && typeof input === "object") {
      if (seen.has(input)) return "[CIRCULAR]";
      seen.add(input);
      const output: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(
        input as Record<string, unknown>,
      )) {
        output[childKey] = visit(childValue, childKey);
      }
      return output;
    }
    return input;
  };

  return visit(value) as T;
}
