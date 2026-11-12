/**
 * Edit-based change tracking, modelled on Visual Studio's Track Changes.
 *
 * Marks come from the edits made in the editor, not from comparing file
 * contents:
 * - every edit marks the lines it touched as changed (yellow), even if the
 *   text ends up identical (type a character, then delete it with Backspace);
 * - saving turns the current changes green;
 * - undo restores the marks from before the edit, so an undone change leaves
 *   no mark; but undoing an edit that had already been saved marks the lines
 *   "reverted" (blue, hatched): they differ from the file on disk;
 * - saving resolves a reverted line to the mark it had before the undone
 *   edit: no mark if it was untouched, green if it had a saved change;
 * - redo restores the marks from after the edit.
 *
 * No dependency on the vscode API, so it can be unit tested with plain Node.
 */

export interface TextChange {
    /** Range replaced, in the document as it was before the change. */
    startLine: number;
    startChar: number;
    endLine: number;
    endChar: number;
    /** Text inserted in its place. */
    text: string;
}

export interface Marks {
    /** Changed and not yet saved (yellow). */
    unsaved: number[];
    /** Changed and saved (green). */
    saved: number[];
    /** A saved change was undone; resolves on the next save (blue, hatched). */
    reverted: number[];
}

/**
 * Each line holds a token: 0 for "untouched", otherwise the id of the edit
 * that last changed it. A token is green if it is part of the saved file,
 * reverted if it is a key of revertedBase, and yellow otherwise.
 */
type Snapshot = Int32Array; // run-length encoded: [token, count, token, count, ...]

interface Entry {
    id: number;
    before: Snapshot;
    after: Snapshot;
    hashBefore: string;
    hashAfter: string;
}

export class LineTracker {
    private lines: number[];
    private hash: string;
    private nextToken = 1;
    private undoStack: Entry[] = [];
    private redoStack: Entry[] = [];
    /** Tokens that are part of the file as last saved. */
    private savedTokens = new Set<number>();
    /** Reverted token -> the token the line had before the undone edit. */
    private revertedBase = new Map<number, number>();

    constructor(lineCount: number, textHash: string, private readonly maxHistory = 5000) {
        this.lines = new Array(Math.max(lineCount, 1)).fill(0);
        this.hash = textHash;
    }

    get lineCount(): number {
        return this.lines.length;
    }

    /** A normal edit (typing, paste, format, ...). */
    edit(changes: TextChange[], newHash: string): void {
        const real = changes.filter((c) => c.text !== '' || c.startLine !== c.endLine || c.startChar !== c.endChar);
        if (real.length === 0) {
            this.hash = newHash;
            return;
        }
        const id = this.nextToken++;
        const before = encode(this.lines);
        const hashBefore = this.hash;
        this.apply(real, id);
        this.hash = newHash;
        this.undoStack.push({ id, before, after: encode(this.lines), hashBefore, hashAfter: newHash });
        if (this.undoStack.length > this.maxHistory) {
            this.undoStack.splice(0, this.undoStack.length - this.maxHistory);
        }
        this.redoStack = [];
    }

    /** An undo. VS Code may undo several of our edits at once (typing is grouped). */
    undo(changes: TextChange[], newHash: string): void {
        let i = this.undoStack.length - 1;
        while (i >= 0 && this.undoStack[i].hashBefore !== newHash) {
            i--;
        }
        const restored = i >= 0 ? decode(this.undoStack[i].before) : undefined;
        if (!restored || restored.length !== this.expectedLength(changes)) {
            // History out of sync (e.g. edits made before tracking started).
            this.edit(changes, newHash);
            return;
        }
        const undone = this.undoStack.splice(i); // oldest first
        this.redoStack.push(...undone.slice().reverse()); // oldest ends on top
        this.restore(changes, restored);
        if (undone.some((e) => this.savedTokens.has(e.id))) {
            // One reverted token per distinct underlying mark.
            const byBase = new Map<number, number>();
            for (const line of this.touchedLines(changes)) {
                const base = this.baseOf(this.lines[line]);
                let token = byBase.get(base);
                if (token === undefined) {
                    token = this.nextToken++;
                    byBase.set(base, token);
                    this.revertedBase.set(token, base);
                }
                this.lines[line] = token;
            }
        }
        this.hash = newHash;
    }

    /** A redo. */
    redo(changes: TextChange[], newHash: string): void {
        let i = this.redoStack.length - 1;
        while (i >= 0 && this.redoStack[i].hashAfter !== newHash) {
            i--;
        }
        const restored = i >= 0 ? decode(this.redoStack[i].after) : undefined;
        if (!restored || restored.length !== this.expectedLength(changes)) {
            this.edit(changes, newHash);
            return;
        }
        const redone = this.redoStack.splice(i).reverse(); // oldest first
        this.undoStack.push(...redone);
        this.restore(changes, restored);
        this.hash = newHash;
    }

    /** The document was saved: everything currently in it is on disk. */
    save(): void {
        // Reverted lines now match the disk: show the mark they had before the undone edit.
        for (let i = 0; i < this.lines.length; i++) {
            this.lines[i] = this.baseOf(this.lines[i]);
        }
        this.savedTokens = new Set(this.lines);
        for (const e of this.undoStack) {
            this.savedTokens.add(e.id);
        }
        this.savedTokens.delete(0);
    }

    /** Forget all marks and history. */
    reset(): void {
        this.lines.fill(0);
        this.undoStack = [];
        this.redoStack = [];
        this.savedTokens.clear();
        this.revertedBase.clear();
    }

    /** Defensive: keep the line array the same length as the document. */
    sync(lineCount: number): void {
        const n = Math.max(lineCount, 1);
        if (this.lines.length > n) {
            this.lines.length = n;
        } else {
            while (this.lines.length < n) {
                this.lines.push(0);
            }
        }
    }

    marks(): Marks {
        const result: Marks = { unsaved: [], saved: [], reverted: [] };
        for (let line = 0; line < this.lines.length; line++) {
            const t = this.lines[line];
            if (t === 0) {
                continue;
            }
            if (this.revertedBase.has(t)) {
                result.reverted.push(line);
            } else if (this.savedTokens.has(t)) {
                result.saved.push(line);
            } else {
                result.unsaved.push(line);
            }
        }
        return result;
    }

    // ---- internals ----------------------------------------------------------

    private baseOf(token: number): number {
        return this.revertedBase.get(token) ?? token;
    }

    /** Changes sorted top to bottom, with their start line after the change. */
    private layout(changes: TextChange[]) {
        const sorted = changes
            .map((c) => ({ c, nl: countNewlines(c.text), post: 0 }))
            .sort((a, b) => a.c.startLine - b.c.startLine || a.c.startChar - b.c.startChar);
        let delta = 0;
        for (const s of sorted) {
            s.post = s.c.startLine + delta;
            delta += s.nl - (s.c.endLine - s.c.startLine);
        }
        return { sorted, delta };
    }

    private expectedLength(changes: TextChange[]): number {
        return this.lines.length + this.layout(changes).delta;
    }

    /**
     * Mark every line the change spans after it is applied. Pressing Enter
     * marks both the line the cursor was on and the new line, as in Visual Studio.
     */
    private apply(changes: TextChange[], token: number): void {
        const { sorted } = this.layout(changes);
        // Bottom-up, so the "before" coordinates of the remaining changes stay valid.
        for (let i = sorted.length - 1; i >= 0; i--) {
            const { c, nl } = sorted[i];
            const replacement = new Array<number>(nl + 1).fill(token);
            this.lines = this.lines.slice(0, c.startLine).concat(replacement, this.lines.slice(c.endLine + 1));
        }
        if (this.lines.length === 0) {
            this.lines.push(0);
        }
    }

    /**
     * Take the marks of the lines this undo/redo rewrote from the snapshot;
     * every other line keeps its current mark (e.g. yellow from an earlier undo).
     */
    private restore(changes: TextChange[], snapshot: number[]): void {
        const { sorted } = this.layout(changes);
        for (let i = sorted.length - 1; i >= 0; i--) {
            const { c, nl, post } = sorted[i];
            const replacement = snapshot.slice(post, post + nl + 1);
            this.lines = this.lines.slice(0, c.startLine).concat(replacement, this.lines.slice(c.endLine + 1));
        }
    }

    /** Lines (after the change) that the change spans. */
    private touchedLines(changes: TextChange[]): number[] {
        const result: number[] = [];
        for (const { nl, post } of this.layout(changes).sorted) {
            for (let line = post; line <= post + nl && line < this.lines.length; line++) {
                result.push(line);
            }
        }
        return result;
    }
}

function countNewlines(text: string): number {
    let n = 0;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) {
            n++;
        }
    }
    return n;
}

function encode(lines: number[]): Snapshot {
    const out: number[] = [];
    for (let i = 0; i < lines.length; ) {
        const t = lines[i];
        let j = i + 1;
        while (j < lines.length && lines[j] === t) {
            j++;
        }
        out.push(t, j - i);
        i = j;
    }
    return Int32Array.from(out);
}

function decode(s: Snapshot): number[] {
    const out: number[] = [];
    for (let i = 0; i < s.length; i += 2) {
        for (let k = 0; k < s[i + 1]; k++) {
            out.push(s[i]);
        }
    }
    return out;
}

/** Fast 2x32-bit hash of the whole text, used to line our history up with VS Code's undo stack. */
export function hashText(text: string): string {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 0x01000193);
        h2 = Math.imul(h2 + ch, 0x5bd1e995) ^ (h2 >>> 15);
    }
    return `${text.length}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`;
}
