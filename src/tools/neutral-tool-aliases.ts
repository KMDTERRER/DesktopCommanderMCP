import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const FileGetSchema = z.object({
    path: z.string(),
    from: z.number().optional(),
    count: z.number().int().positive().optional(),
}).strict();

const FilePutSchema = z.object({
    path: z.string(),
    data: z.string(),
    append: z.boolean().optional(),
}).strict();

const SearchRunSchema = z.object({
    path: z.string(),
    query: z.string(),
    kind: z.enum(['files', 'content']).optional().default('files'),
    max: z.number().int().positive().optional(),
}).strict();

const ProcessRunSchema = z.object({
    command: z.string().min(1).optional(),
    exe: z.string().min(1).optional(),
    args: z.array(z.string()).optional().default([]),
    cwd: z.string().optional(),
    wait_ms: z.number().int().min(0).optional(),
}).strict().refine(v => Boolean(v.command) !== Boolean(v.exe), {
    message: 'Provide exactly one of command or exe',
});

const ProcessPollSchema = z.object({
    id: z.number(),
    wait_ms: z.number().int().min(0).optional(),
    from: z.number().optional(),
    count: z.number().int().positive().optional(),
}).strict();

const StopSchema = z.object({ id: z.number() }).strict();

type AliasResolution = { canonicalName: string; args: Record<string, unknown> };

export function resolveNeutralToolAlias(name: string, rawArgs: unknown): AliasResolution | null {
    switch (name) {
        case 'file_get': {
            const v = FileGetSchema.parse(rawArgs ?? {});
            return { canonicalName: 'read_file', args: { path: v.path, offset: v.from ?? 0, length: v.count ?? 1000 } };
        }
        case 'file_put': {
            const raw = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
                ? rawArgs as Record<string, unknown>
                : {};
            const appendProvided = Object.prototype.hasOwnProperty.call(raw, 'append');
            const v = FilePutSchema.parse(raw);
            return {
                canonicalName: 'write_file',
                args: {
                    path: v.path, content: v.data,
                    ...(appendProvided ? { mode: v.append === true ? 'append' : 'rewrite' } : {}),
                },
            };
        }
        case 'search_run': {
            const v = SearchRunSchema.parse(rawArgs ?? {});
            return { canonicalName: 'start_search', args: { path: v.path, pattern: v.query, searchType: v.kind, ...(v.max ? { maxResults: v.max } : {}) } };
        }
        case 'process_run': {
            const v = ProcessRunSchema.parse(rawArgs ?? {});
            return { canonicalName: 'start_process', args: { ...(v.command ? { command: v.command } : { executable: v.exe }), args: v.args, ...(v.cwd ? { cwd: v.cwd } : {}), ...(v.wait_ms !== undefined ? { timeout_ms: v.wait_ms } : {}) } };
        }
        case 'process_poll': {
            const v = ProcessPollSchema.parse(rawArgs ?? {});
            return { canonicalName: 'read_process_output', args: { pid: v.id, ...(v.wait_ms !== undefined ? { timeout_ms: v.wait_ms } : {}), ...(v.from !== undefined ? { offset: v.from } : {}), ...(v.count !== undefined ? { length: v.count } : {}) } };
        }
        case 'session_stop': {
            const v = StopSchema.parse(rawArgs ?? {});
            return { canonicalName: 'force_terminate', args: { pid: v.id } };
        }
        case 'process_stop': {
            const v = StopSchema.parse(rawArgs ?? {});
            return { canonicalName: 'kill_process', args: { pid: v.id } };
        }
        default:
            return null;
    }
}

const alias = (name: string, description: string, schema: z.ZodTypeAny, readOnly: boolean, openWorld = false) => ({
    name, description, inputSchema: zodToJsonSchema(schema),
    annotations: {
        title: name.replace(/_/g, ' '),
        readOnlyHint: readOnly,
        ...(readOnly ? {} : { destructiveHint: true, openWorldHint: openWorld }),
    },
});

export function listNeutralToolAliases() {
    return [
        alias('file_get', 'Read file data using the same security boundary as read_file.', FileGetSchema, true),
        alias('file_put', 'Write file data using the same security boundary as write_file.', FilePutSchema, false),
        alias('search_run', 'Start a filesystem/content search with a compact argument shape.', SearchRunSchema, true),
        alias('process_run', 'Run a command or executable with the existing process boundary.', ProcessRunSchema, false, true),
        alias('process_poll', 'Read output from an existing managed process.', ProcessPollSchema, true),
        alias('session_stop', 'Stop a managed terminal session.', StopSchema, false),
        alias('process_stop', 'Stop a system process through the existing process handler.', StopSchema, false),
    ];
}
