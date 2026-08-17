import { toolHistory } from '../utils/toolHistory.js';
import { GetRecentToolCallsArgsSchema, TrackUiEventArgsSchema } from '../tools/schemas.js';
import { ServerResult } from '../types.js';
import { capture_ui_event } from '../utils/capture.js';

type TrackUiEventParams = Record<string, string | number | boolean | null>;

export function buildTrackUiEventCapturePayload(event: string, component: string, params: TrackUiEventParams): Record<string, string | number | boolean | null> {
  return {
    ...params,
    component,
    event
  };
}

/**
 * Handle get_recent_tool_calls command
 */
export async function handleGetRecentToolCalls(args: unknown): Promise<ServerResult> {
  try {
    const parsed = GetRecentToolCallsArgsSchema.parse(args);
    
    // Use formatted version with local timezone
    const calls = toolHistory.getRecentCallsFormatted({
      maxResults: parsed.maxResults,
      toolName: parsed.toolName,
      since: parsed.since
    });
    
    const stats = toolHistory.getStats();

    // History is diagnostic context, not a bulk export. Keep the newest matching
    // records within one bounded response so a debugging request cannot itself
    // saturate Remote/MCP result delivery. Serialize records individually rather
    // than materializing the full requested array first.
    const bodyBudget = Math.max(1024, parsed.maxOutputChars - 512);
    const selected: string[] = [];
    let selectedChars = 4; // [\n + \n]
    for (let index = calls.length - 1; index >= 0; index--) {
      const serialized = JSON.stringify(calls[index], null, 2);
      const separatorChars = selected.length > 0 ? 2 : 0; // comma + newline
      if (selected.length > 0 && selectedChars + separatorChars + serialized.length > bodyBudget) break;
      if (selected.length === 0 && serialized.length > bodyBudget) {
        const call = calls[index];
        selected.unshift(JSON.stringify({
          timestamp: call.timestamp, toolName: call.toolName, duration: call.duration,
          _history: `[record omitted: ${serialized.length} chars exceeds response budget]`,
        }, null, 2));
        selectedChars += selected[0].length;
        break;
      }
      selected.unshift(serialized);
      selectedChars += separatorChars + serialized.length;
    }
    const omitted = Math.max(0, calls.length - selected.length);
    const historyJson = `[\n${selected.join(',\n')}\n]`;
    const summary = `Tool Call History (${selected.length} shown of ${calls.length} matched, ${stats.totalEntries} total in memory` +
      `${omitted > 0 ? `, ${omitted} older matched record(s) omitted by ${parsed.maxOutputChars}-char response budget` : ''})`;

    return {
      content: [{
        type: "text",
        text: `${summary}\n\n${historyJson}`
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `Error getting tool history: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}

/**
 * Handle track_ui_event command
 */
export async function handleTrackUiEvent(args: unknown): Promise<ServerResult> {
  try {
    const parsed = TrackUiEventArgsSchema.parse(args);

    await capture_ui_event('mcp_ui_event', buildTrackUiEventCapturePayload(parsed.event, parsed.component, parsed.params));

    return {
      content: [{
        type: "text",
        text: `Tracked UI event: ${parsed.event}`
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `Error tracking UI event: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}
