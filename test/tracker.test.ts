import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { hashText, LineTracker, Marks, TextChange } from '../src/tracker';

/** A tiny editor model: a document plus VS Code-like undo/redo groups. */
class Editor {
    lines: string[];
    tracker: LineTracker;
    private undoGroups: TextChange[][] = []; // inverse changes, one group per undo stop
    private redoGroups: TextChange[][] = [];
    private grouping = false;

    constructor(text: string) {
        this.lines = text.split('\n');
        this.tracker = new LineTracker(this.lines.length, hashText(this.text));
    }

    get text(): string {
        return this.lines.join('\n');
    }

    private lineAt = (n: number) => this.lines[n] ?? '';

    /** Replace a range; returns the inverse change. */
    private applyRaw(c: TextChange): TextChange {
        const before = this.lines.slice(c.startLine, c.endLine + 1).join('\n');
        const head = this.lines[c.startLine].slice(0, c.startChar);
        const tail = this.lines[c.endLine].slice(c.endChar);
        const oldText = before.slice(c.startChar, before.length - (this.lines[c.endLine].length - c.endChar));
        const inserted = (head + c.text + tail).split('\n');
        this.lines.splice(c.startLine, c.endLine - c.startLine + 1, ...inserted);
        const nl = c.text.split('\n').length - 1;
        const lastSeg = c.text.split('\n')[nl];
        return {
            startLine: c.startLine,
            startChar: c.startChar,
            endLine: c.startLine + nl,
            endChar: nl === 0 ? c.startChar + c.text.length : lastSeg.length,
            text: oldText,
        };
    }

    /** A user edit. `group: true` merges it into the previous undo group (like typing). */
    edit(c: TextChange, group = false): this {
        const inverse = this.applyRaw(c);
        if (group && this.grouping && this.undoGroups.length > 0) {
            this.undoGroups[this.undoGroups.length - 1].unshift(inverse);
        } else {
            this.undoGroups.push([inverse]);
        }
        this.grouping = true;
        this.redoGroups = [];
        this.tracker.edit([c], hashText(this.text), this.lineAt);
        return this;
    }

    type(line: number, ch: number, text: string, group = false): this {
        return this.edit({ startLine: line, startChar: ch, endLine: line, endChar: ch, text }, group);
    }

    del(line: number, ch: number, endLine: number, endChar: number): this {
        return this.edit({ startLine: line, startChar: ch, endLine, endChar, text: '' });
    }

    /** Undo one group; VS Code reports it as a single event. */
    undo(): this {
        const group = this.undoGroups.pop();
        assert.ok(group, 'nothing to undo');
        // Apply the inverse changes in order, collect their inverses for redo,
        // and report them to the tracker as one event.
        const redo: TextChange[] = [];
        for (const c of group) {
            redo.unshift(this.applyRaw(c));
        }
        this.redoGroups.push(redo);
        this.grouping = false;
        this.tracker.undo(group.length === 1 ? group : [mergeSequential(group)], hashText(this.text), this.lineAt);
        return this;
    }

    redo(): this {
        const group = this.redoGroups.pop();
        assert.ok(group, 'nothing to redo');
        const undo: TextChange[] = [];
        for (const c of group) {
            undo.unshift(this.applyRaw(c));
        }
        this.undoGroups.push(undo);
        this.grouping = false;
        this.tracker.redo(group.length === 1 ? group : [mergeSequential(group)], hashText(this.text), this.lineAt);
        return this;
    }

    save(): this {
        this.grouping = false;
        this.tracker.save();
        return this;
    }

    marks(): Marks {
        return this.tracker.marks();
    }
}

/**
 * The tracker only uses an undo event's ranges to find the touched lines; for
 * grouped single-line typing a covering change of the whole line is enough.
 */
function mergeSequential(group: TextChange[]): TextChange {
    const startLine = Math.min(...group.map((c) => c.startLine));
    return { startLine, startChar: 0, endLine: startLine, endChar: 0, text: '' };
}

const none: Marks = { unsaved: [], saved: [], reverted: [] };
const doc = () => new Editor('line0\nline1\nline2\nline3');

test('opening a file shows no marks', () => {
    assert.deepEqual(doc().marks(), none);
});

test('typing marks the line yellow', () => {
    assert.deepEqual(doc().type(1, 5, 'x').marks(), { ...none, unsaved: [1] });
});

test('Enter at end of line, then undo: no marks', () => {
    const e = doc().type(1, 5, '\n    ');
    assert.deepEqual(e.marks(), { ...none, unsaved: [2] });
    assert.deepEqual(e.undo().marks(), none);
});

test('Enter in the middle of a line marks both halves', () => {
    assert.deepEqual(doc().type(1, 2, '\n').marks(), { ...none, unsaved: [1, 2] });
});

test('Enter at column 0 marks only the new empty line', () => {
    assert.deepEqual(doc().type(1, 0, '\n').marks(), { ...none, unsaved: [1] });
});

test('typing then Backspace keeps the line yellow (edits, not content)', () => {
    const e = doc().type(1, 5, 'x').del(1, 5, 1, 6);
    assert.equal(e.text, doc().text);
    assert.deepEqual(e.marks(), { ...none, unsaved: [1] });
});

test('grouped typing undone in one step: no marks', () => {
    const e = doc().type(1, 5, 'a').type(1, 6, 'b', true).type(1, 7, 'c', true);
    assert.deepEqual(e.marks(), { ...none, unsaved: [1] });
    assert.deepEqual(e.undo().marks(), none);
});

test('save turns changes green', () => {
    assert.deepEqual(doc().type(1, 5, 'x').save().marks(), { ...none, saved: [1] });
});

test('save then undo: orange', () => {
    const e = doc().type(1, 5, 'x').save().undo();
    assert.deepEqual(e.marks(), { ...none, reverted: [1] });
});

test('save, undo (orange), redo: green again', () => {
    const e = doc().type(1, 5, 'x').save().undo().redo();
    assert.deepEqual(e.marks(), { ...none, saved: [1] });
});

test('orange, then save: green', () => {
    const e = doc().type(1, 5, 'x').save().undo().save();
    assert.deepEqual(e.marks(), { ...none, saved: [1] });
});

test('orange, save, redo: yellow (differs from disk again)', () => {
    const e = doc().type(1, 5, 'x').save().undo().save().redo();
    assert.deepEqual(e.marks(), { ...none, unsaved: [1] });
});

test('undo an unsaved change on top of a saved one: back to green', () => {
    const e = doc().type(1, 5, 'x').save().type(1, 6, 'y');
    assert.deepEqual(e.marks(), { ...none, unsaved: [1] });
    assert.deepEqual(e.undo().marks(), { ...none, saved: [1] });
});

test('green and yellow lines side by side', () => {
    const e = doc().type(0, 5, 'x').save().type(3, 5, 'y');
    assert.deepEqual(e.marks(), { ...none, saved: [0], unsaved: [3] });
});

test('marks move with inserted lines', () => {
    const e = doc().type(2, 5, 'x').type(0, 0, 'new\n');
    assert.deepEqual(e.marks(), { ...none, unsaved: [0, 3] });
});

test('deleting lines marks the line where they were', () => {
    const e = doc().del(1, 0, 3, 0);
    assert.deepEqual(e.text, 'line0\nline3');
    assert.deepEqual(e.marks(), { ...none, unsaved: [1] });
});

test('deleting lines then undo: no marks', () => {
    assert.deepEqual(doc().del(1, 0, 3, 0).undo().marks(), none);
});

test('undo then redo of an unsaved edit: yellow', () => {
    assert.deepEqual(doc().type(1, 5, 'x').undo().redo().marks(), { ...none, unsaved: [1] });
});

test('new edit after undo clears redo history', () => {
    const e = doc().type(1, 5, 'x').undo().type(2, 5, 'y');
    assert.deepEqual(e.marks(), { ...none, unsaved: [2] });
});

test('two saves, undo both: both lines orange', () => {
    const e = doc().type(0, 5, 'a').save().type(2, 5, 'b').save().undo();
    assert.deepEqual(e.marks(), { ...none, saved: [0], reverted: [2] });
    assert.deepEqual(e.undo().marks(), { ...none, reverted: [0, 2] });
});

test('multi-cursor edit in one event', () => {
    const t = new LineTracker(4, 'h0');
    const lines = ['line0', 'line1', 'line2', 'line3'];
    const lineAt = (n: number) => lines[n];
    t.edit(
        [
            { startLine: 3, startChar: 0, endLine: 3, endChar: 0, text: '#' },
            { startLine: 1, startChar: 0, endLine: 1, endChar: 0, text: '#' },
        ],
        'h1',
        lineAt,
    );
    assert.deepEqual(t.marks(), { ...none, unsaved: [1, 3] });
});

test('undo with no matching history falls back to marking yellow', () => {
    const t = new LineTracker(2, 'h0');
    t.undo([{ startLine: 0, startChar: 0, endLine: 0, endChar: 1, text: '' }], 'unknown', () => 'x');
    assert.deepEqual(t.marks(), { ...none, unsaved: [0] });
});

test('reset clears everything', () => {
    const e = doc().type(0, 5, 'a').save().type(2, 5, 'b');
    e.tracker.reset();
    assert.deepEqual(e.marks(), none);
});
