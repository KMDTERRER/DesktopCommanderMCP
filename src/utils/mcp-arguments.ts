export function normalizeMcpArgumentsObject(
  value: unknown,
  label = 'MCP tool arguments',
): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

const FORBIDDEN_JSON_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

export function assertNoUnexpectedJsonControlCharacters(
  value: unknown,
  label = 'MCP compatibility payload',
): void {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === 'string') {
      if (FORBIDDEN_JSON_CONTROL_RE.test(current)) {
        throw new Error(`${label} contains a non-whitespace control character. Literal backslash escapes must be double-escaped in nested JSON.`);
      }
      continue;
    }
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (current && typeof current === 'object') {
      for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
        if (FORBIDDEN_JSON_CONTROL_RE.test(key)) {
          throw new Error(`${label} contains a control character in an object key.`);
        }
        stack.push(item);
      }
    }
  }
}
