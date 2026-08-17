import { distance } from 'fastest-levenshtein';

/**
 * Pure fuzzy-search core, kept free of app imports on purpose: it runs inside
 * the worker thread spawned by runFuzzySearchInWorker (fuzzySearch.ts), and
 * anything imported here is loaded per worker. Telemetry is returned as data
 * and captured on the main thread, which has the real client identity.
 */

export interface FuzzyMatch {
    start: number;
    end: number;
    value: string;
    distance: number;
}

export interface FuzzySearchMetrics {
    recursive: {
        execution_time_ms: number;
        text_length: number;
        query_length: number;
        result_distance: number;
    };
    iterative: {
        execution_time_ms: number;
        iterations: number;
        segment_length: number;
        query_length: number;
        final_distance: number;
    } | null;
}

// Set by iterativeReduction during a search (exactly one terminal call per
// search) and collected by runFuzzySearch. Single-threaded per context, so a
// module-level slot is safe.
let lastIterativeMetrics: FuzzySearchMetrics['iterative'] = null;

/**
 * Runs a full fuzzy search and returns the match together with the timing
 * metrics that used to be captured inline.
 */
export function runFuzzySearch(text: string, query: string): { result: FuzzyMatch; metrics: FuzzySearchMetrics } {
    const startTime = performance.now();
    lastIterativeMetrics = null;
    const result = recursiveFuzzyIndexOf(text, query);
    return {
        result,
        metrics: {
            recursive: {
                execution_time_ms: performance.now() - startTime,
                text_length: text.length,
                query_length: query.length,
                result_distance: result.distance
            },
            iterative: lastIterativeMetrics
        }
    };
}

const MAX_CANDIDATE_QUERY_LENGTH = 4096;
const MAX_ANCHORS = 12;
const MAX_OCCURRENCES_PER_ANCHOR = 512;
const MAX_CANDIDATE_STARTS = 4096;

function chooseBetter(a: FuzzyMatch | null, b: FuzzyMatch): FuzzyMatch {
    if (!a || b.distance < a.distance || (b.distance === a.distance && b.start < a.start)) return b;
    return a;
}

function addCandidateStart(candidates: Set<number>, rawStart: number, textLength: number, queryLength: number): void {
    const maxStart = Math.max(0, textLength - Math.max(1, queryLength));
    // A nearby exact q-gram can move by a few positions when an insertion or
    // deletion occurs before it. Check a tiny deterministic drift window.
    for (let drift = -2; drift <= 2 && candidates.size < MAX_CANDIDATE_STARTS; drift++) {
        candidates.add(Math.max(0, Math.min(maxStart, rawStart + drift)));
    }
}

function usefulAnchor(anchor: string): boolean {
    const trimmed = anchor.trim();
    if (trimmed.length < 4) return false;
    return new Set(trimmed).size >= Math.min(3, trimmed.length);
}

function candidateFuzzyMatch(text: string, query: string): FuzzyMatch | null {
    if (!query || !text || query.length > MAX_CANDIDATE_QUERY_LENGTH) return null;
    let best: FuzzyMatch | null = null;

    // Single-line edits are common for edit_block and can be searched exactly
    // across line candidates. Length filtering is only a performance filter; a
    // line outside 0.5x..2x cannot be a useful >=70% suggestion anyway.
    if (!query.includes('\n') && !query.includes('\r')) {
        const minLength = Math.max(1, Math.floor(query.length * 0.5));
        const maxLength = Math.max(query.length + 8, Math.ceil(query.length * 2));
        let lineStart = 0;
        while (lineStart <= text.length) {
            let newline = text.indexOf('\n', lineStart);
            if (newline < 0) newline = text.length;
            let lineEnd = newline;
            if (lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13) lineEnd--;
            const lineLength = lineEnd - lineStart;
            if (lineLength >= minLength && lineLength <= maxLength) {
                const value = text.substring(lineStart, lineEnd);
                const candidate = { start: lineStart, end: lineEnd, value, distance: distance(value, query) };
                best = chooseBetter(best, candidate);
                if (candidate.distance === 0) return candidate;
            }
            if (newline === text.length) break;
            lineStart = newline + 1;
        }
    }

    // RapidFuzz-style two-stage idea: exact q-grams cheaply nominate likely
    // alignments, then Levenshtein ranks only those local windows. Unlike the
    // old divide-and-conquer heuristic this never discards half the file based
    // on the edit distance of an oversized half.
    const anchorLength = Math.min(24, Math.max(8, Math.floor(query.length / 8)));
    if (query.length >= anchorLength) {
        const candidates = new Set<number>();
        const span = query.length - anchorLength;
        const anchorCount = Math.min(MAX_ANCHORS, Math.max(1, Math.ceil(query.length / anchorLength)));
        const offsets = new Set<number>();
        for (let index = 0; index < anchorCount; index++) {
            offsets.add(anchorCount === 1 ? 0 : Math.round((span * index) / (anchorCount - 1)));
        }
        for (const offset of offsets) {
            if (candidates.size >= MAX_CANDIDATE_STARTS) break;
            const anchor = query.substring(offset, offset + anchorLength);
            if (!usefulAnchor(anchor)) continue;
            let from = 0;
            for (let occurrence = 0; occurrence < MAX_OCCURRENCES_PER_ANCHOR; occurrence++) {
                const found = text.indexOf(anchor, from);
                if (found < 0) break;
                addCandidateStart(candidates, found - offset, text.length, query.length);
                if (candidates.size >= MAX_CANDIDATE_STARTS) break;
                from = found + 1;
            }
        }
        for (const start of candidates) {
            const end = Math.min(text.length, start + query.length);
            const value = text.substring(start, end);
            const candidate = { start, end, value, distance: distance(value, query) };
            best = chooseBetter(best, candidate);
            if (candidate.distance === 0) return candidate;
        }
    }
    return best;
}

/**
 * Finds a close substring. Candidate retrieval fixes the large-file false
 * negatives of the historical recursive heuristic; the heuristic remains as
 * a bounded best-effort fallback for long/anchorless patterns.
 */
export function recursiveFuzzyIndexOf(text: string, query: string, start: number = 0, end: number | null = null, parentDistance: number = Infinity): FuzzyMatch {
    if (end === null) end = text.length;
    if (start === 0 && end === text.length && parentDistance === Infinity) {
        const candidate = candidateFuzzyMatch(text, query);
        const fallback = recursiveFuzzyHeuristic(text, query, start, end, parentDistance);
        return chooseBetter(candidate, fallback);
    }
    return recursiveFuzzyHeuristic(text, query, start, end, parentDistance);
}

function recursiveFuzzyHeuristic(text: string, query: string, start: number, end: number, parentDistance: number): FuzzyMatch {
    if (end - start <= 2 * query.length) {
        return iterativeReduction(text, query, start, end, parentDistance);
    }

    const midPoint = start + Math.floor((end - start) / 2);
    const leftEnd = Math.min(end, midPoint + query.length);
    const rightStart = Math.max(start, midPoint - query.length);
    const leftDistance = distance(text.substring(start, leftEnd), query);
    const rightDistance = distance(text.substring(rightStart, end), query);
    const bestDistance = Math.min(leftDistance, parentDistance, rightDistance);

    if (parentDistance === bestDistance) {
        return iterativeReduction(text, query, start, end, parentDistance);
    }
    if (leftDistance < rightDistance) {
        return recursiveFuzzyHeuristic(text, query, start, leftEnd, bestDistance);
    }
    return recursiveFuzzyHeuristic(text, query, rightStart, end, bestDistance);
}

/**
 * Iteratively refines the best match by reducing the search area
 * @param text The text to search within
 * @param query The query string to find
 * @param start Start index in the text
 * @param end End index in the text
 * @param parentDistance Best distance found so far
 * @returns Object with start and end indices, matched value, and Levenshtein distance
 */
function iterativeReduction(text: string, query: string, start: number, end: number, parentDistance: number): FuzzyMatch {
    const startTime = performance.now();
    let iterations = 0;

    // Seed with the measured distance of this slice. For recursive callers
    // this equals parentDistance (the parent measured exactly this slice), but
    // a top-level call on text <= 2x query length arrives with Infinity, which
    // made the first shrink unconditional and a position-0 match unreachable.
    let bestDistance = distance(text.substring(start, end), query);
    let bestStart = start;
    let bestEnd = end;

    // Improve start position
    let nextDistance = distance(text.substring(bestStart + 1, bestEnd), query);

    while (nextDistance < bestDistance) {
        bestDistance = nextDistance;
        bestStart++;
        const smallerString = text.substring(bestStart + 1, bestEnd);
        nextDistance = distance(smallerString, query);
        iterations++;
    }

    // Improve end position
    nextDistance = distance(text.substring(bestStart, bestEnd - 1), query);

    while (nextDistance < bestDistance) {
        bestDistance = nextDistance;
        bestEnd--;
        const smallerString = text.substring(bestStart, bestEnd - 1);
        nextDistance = distance(smallerString, query);
        iterations++;
    }

    lastIterativeMetrics = {
        execution_time_ms: performance.now() - startTime,
        iterations: iterations,
        segment_length: end - start,
        query_length: query.length,
        final_distance: bestDistance
    };

    return {
        start: bestStart,
        end: bestEnd,
        value: text.substring(bestStart, bestEnd),
        distance: bestDistance
    };
}

/**
 * Calculates the similarity ratio between two strings
 * @param a First string
 * @param b Second string
 * @returns Similarity ratio (0-1)
 */
export function getSimilarityRatio(a: string, b: string): number {
    const maxLength = Math.max(a.length, b.length);
    if (maxLength === 0) return 1; // Both strings are empty

    const levenshteinDistance = distance(a, b);
    return 1 - (levenshteinDistance / maxLength);
}
