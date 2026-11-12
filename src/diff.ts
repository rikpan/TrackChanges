/**
 * Pure line-diff and classification logic (no dependency on the vscode API,
 * so it can be unit tested with plain Node).
 */

/** Split text into lines, treating CRLF and LF the same. */
export function splitLines(text: string): string[] {
    return text.split(/\r?\n/);
}

/**
 * Returns the set of line indices in `current` that differ from `base`.
 *
 * - Inserted or modified lines are marked directly.
 * - A pure deletion (lines removed with nothing inserted in their place) marks
 *   the line now sitting where the deleted lines were, as Visual Studio does,
 *   unless a neighbouring line is already marked.
 *
 * `maxEditDistance` bounds the work of the Myers algorithm; when the files are
 * more different than that, the whole differing middle region is marked.
 */
export function changedLines(base: string[], current: string[], maxEditDistance = 4000): Set<number> {
    const result = new Set<number>();
    if (current.length === 0) {
        return result;
    }

    // Trim common prefix and suffix: most edits are local, so this makes the
    // expensive part tiny in practice.
    let start = 0;
    const minLen = Math.min(base.length, current.length);
    while (start < minLen && base[start] === current[start]) {
        start++;
    }
    let endBase = base.length;
    let endCur = current.length;
    while (endBase > start && endCur > start && base[endBase - 1] === current[endCur - 1]) {
        endBase--;
        endCur--;
    }
    if (start === endBase && start === endCur) {
        return result; // identical
    }

    // Map lines to integers so comparisons in the hot loop are cheap.
    const ids = new Map<string, number>();
    const toId = (line: string): number => {
        let id = ids.get(line);
        if (id === undefined) {
            id = ids.size;
            ids.set(line, id);
        }
        return id;
    };
    const a = new Int32Array(endBase - start);
    for (let i = 0; i < a.length; i++) {
        a[i] = toId(base[start + i]);
    }
    const b = new Int32Array(endCur - start);
    for (let i = 0; i < b.length; i++) {
        b[i] = toId(current[start + i]);
    }

    const edits = myers(a, b, maxEditDistance);
    const deletionPoints: number[] = [];
    if (edits === null) {
        // Too different: mark the whole middle region.
        for (let i = 0; i < b.length; i++) {
            result.add(start + i);
        }
        if (b.length === 0) {
            deletionPoints.push(start);
        }
    } else {
        for (const y of edits.inserted) {
            result.add(start + y);
        }
        for (const y of edits.deletedAt) {
            deletionPoints.push(start + y);
        }
    }

    for (const y of deletionPoints) {
        if (result.has(y) || result.has(y - 1)) {
            continue;
        }
        result.add(Math.min(y, current.length - 1));
    }
    return result;
}

interface EditScript {
    /** Indices in `b` of inserted lines. */
    inserted: number[];
    /** Positions in `b` before which one or more lines of `a` were deleted. */
    deletedAt: number[];
}

/**
 * Myers O(ND) diff. Returns null if the edit distance exceeds `maxD`.
 */
function myers(a: Int32Array, b: Int32Array, maxD: number): EditScript | null {
    const n = a.length;
    const m = b.length;
    if (n === 0 || m === 0) {
        const inserted: number[] = [];
        for (let i = 0; i < m; i++) {
            inserted.push(i);
        }
        return { inserted, deletedAt: n > 0 ? [0] : [] };
    }

    const max = Math.min(n + m, maxD);
    const offset = max + 1;
    const v = new Int32Array(2 * max + 3);
    // trace[d] holds v[-d..d] as it was before step d.
    const trace: Int32Array[] = [];

    let finalD = -1;
    outer: for (let d = 0; d <= max; d++) {
        trace.push(v.slice(offset - d, offset + d + 1));
        for (let k = -d; k <= d; k += 2) {
            let x: number;
            if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
                x = v[offset + k + 1];
            } else {
                x = v[offset + k - 1] + 1;
            }
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) {
                x++;
                y++;
            }
            v[offset + k] = x;
            if (x >= n && y >= m) {
                finalD = d;
                break outer;
            }
        }
    }
    if (finalD < 0) {
        return null;
    }

    const inserted: number[] = [];
    const deletedAt: number[] = [];
    let x = n;
    let y = m;
    for (let d = finalD; d > 0; d--) {
        const prev = trace[d];
        const at = (k: number) => prev[k + d];
        const k = x - y;
        const fromAbove = k === -d || (k !== d && at(k - 1) < at(k + 1));
        const prevK = fromAbove ? k + 1 : k - 1;
        const prevX = at(prevK);
        const prevY = prevX - prevK;
        // Walk back along the diagonal (matching lines).
        while (x > prevX && y > prevY) {
            x--;
            y--;
        }
        if (fromAbove) {
            inserted.push(prevY); // b[prevY] inserted
        } else {
            deletedAt.push(prevY); // a[prevX] deleted before b[prevY]
        }
        x = prevX;
        y = prevY;
    }
    return { inserted, deletedAt };
}

export type ChangeKind = 'unsaved' | 'saved' | 'reverted';

export interface Classification {
    /** Changed since last save and different from the original (yellow). */
    unsaved: number[];
    /** Changed since the file was opened, and saved (green). */
    saved: number[];
    /** Changed since last save, but back to the original content (orange). */
    reverted: number[];
}

/**
 * Classify current lines the way Visual Studio's Track Changes does.
 *
 * @param original text when tracking started (file opened)
 * @param saved    text at the last save (or same as original if never saved)
 * @param current  current editor text
 */
export function classify(original: string[], saved: string[], current: string[]): Classification {
    const vsSaved = changedLines(saved, current);
    const vsOriginal = original === saved ? vsSaved : changedLines(original, current);

    const unsaved: number[] = [];
    const reverted: number[] = [];
    const savedLines: number[] = [];
    for (const line of vsSaved) {
        if (vsOriginal.has(line)) {
            unsaved.push(line);
        } else {
            reverted.push(line);
        }
    }
    for (const line of vsOriginal) {
        if (!vsSaved.has(line)) {
            savedLines.push(line);
        }
    }
    const asc = (x: number, y: number) => x - y;
    return { unsaved: unsaved.sort(asc), saved: savedLines.sort(asc), reverted: reverted.sort(asc) };
}
