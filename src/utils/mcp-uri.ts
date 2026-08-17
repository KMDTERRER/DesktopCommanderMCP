export function isMcpCompatUri(value: unknown): value is string {
  return typeof value === 'string' && /^mcp:\/\//i.test(value);
}

export function unsupportedMcpReadFileOptions(args: Record<string, unknown>): string[] {
  return [
    args.isUrl === true ? 'isUrl' : null,
    args.offset !== undefined && args.offset !== 0 ? 'offset' : null,
    args.length !== undefined && args.length !== 1000 ? 'length' : null,
    args.sheet !== undefined ? 'sheet' : null,
    args.range !== undefined ? 'range' : null,
  ].filter((value): value is string => value !== null);
}

export function assertMcpCompatWriteFileOptions(args: Record<string, unknown>): void {
  if (Object.prototype.hasOwnProperty.call(args, 'mode') && args.mode !== 'rewrite') {
    throw new Error('mcp:// write_file is an RPC compatibility call and only accepts mode=rewrite.');
  }
}
