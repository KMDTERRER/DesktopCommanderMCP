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
