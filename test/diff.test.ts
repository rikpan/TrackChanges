import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { changedLines, classify, splitLines } from '../src/diff';

const L = (s: string) => splitLines(s);
const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

test('identical text has no changes', () => {
    assert.deepEqual(sorted(changedLines(L('a\nb\nc'), L('a\nb\nc'))), []);
});

test('modified line is marked', () => {
    assert.deepEqual(sorted(changedLines(L('a\nb\nc'), L('a\nB\nc'))), [1]);
});

test('inserted lines are marked', () => {
    assert.deepEqual(sorted(changedLines(L('a\nb\nc'), L('a\nx\ny\nb\nc'))), [1, 2]);
});

test('pure deletion marks the line now at that position', () => {
    assert.deepEqual(sorted(changedLines(L('a\nb\nc\nd'), L('a\nd'))), [1]);
});

test('deletion at end marks the last line', () => {
    assert.deepEqual(sorted(changedLines(L('a\nb\nc'), L('a\nb'))), [1]);
});

test('CRLF and LF are treated alike', () => {
    assert.deepEqual(sorted(changedLines(L('a\r\nb\r\nc'), L('a\nb\nc'))), []);
});

test('repeated lines are aligned correctly', () => {
    // Inserting a duplicate "x" in the middle marks exactly one line.
    const base = L('x\ny\nx\ny\nx');
    const cur = L('x\ny\nx\nx\ny\nx');
    assert.equal(changedLines(base, cur).size, 1);
});

test('scattered edits across a large file', () => {
    const base = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    const cur = base.slice();
    cur[10] = 'changed';
    cur.splice(2000, 0, 'new');
    cur.splice(4000, 3);
    const changed = sorted(changedLines(base, cur));
    assert.deepEqual(changed, [10, 2000, 4000]);
});

test('falls back to marking the middle region when too different', () => {
    const base = Array.from({ length: 100 }, (_, i) => `a${i}`);
    const cur = Array.from({ length: 100 }, (_, i) => `b${i}`);
    assert.equal(changedLines(base, cur, 10).size, 100);
});

test('random edits: every unmarked line maps to an equal base line', () => {
    let seed = 42;
    const rand = (n: number) => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed % n;
    };
    for (let iter = 0; iter < 200; iter++) {
        const base = Array.from({ length: 30 + rand(30) }, () => `l${rand(8)}`);
        const cur = base.slice();
        for (let e = 0; e < 1 + rand(6); e++) {
            const op = rand(3);
            const at = rand(cur.length + 1);
            if (op === 0) cur.splice(at, 0, `n${rand(8)}`);
            else if (op === 1 && cur.length > 1) cur.splice(Math.min(at, cur.length - 1), 1);
            else if (cur.length > 0) cur[Math.min(at, cur.length - 1)] = `m${rand(8)}`;
        }
        const changed = changedLines(base, cur);
        // Unmarked lines must form a common subsequence of base and cur.
        const kept = cur.filter((_, i) => !changed.has(i));
        let j = 0;
        for (const line of base) {
            if (j < kept.length && kept[j] === line) j++;
        }
        assert.equal(j, kept.length, `iteration ${iter}`);
    }
});

// ---- Visual Studio semantics ---------------------------------------------

test('edit without saving is yellow (unsaved)', () => {
    const orig = L('a\nb\nc');
    const r = classify(orig, orig, L('a\nB\nc'));
    assert.deepEqual(r, { unsaved: [1], saved: [], reverted: [] });
});

test('edit then save is green (saved)', () => {
    const orig = L('a\nb\nc');
    const saved = L('a\nB\nc');
    const r = classify(orig, saved, saved);
    assert.deepEqual(r, { unsaved: [], saved: [1], reverted: [] });
});

test('save, then edit another line: green + yellow', () => {
    const orig = L('a\nb\nc');
    const saved = L('a\nB\nc');
    const r = classify(orig, saved, L('a\nB\nC'));
    assert.deepEqual(r, { unsaved: [2], saved: [1], reverted: [] });
});

test('save, then change the saved line again: yellow', () => {
    const orig = L('a\nb\nc');
    const saved = L('a\nB\nc');
    const r = classify(orig, saved, L('a\nBB\nc'));
    assert.deepEqual(r, { unsaved: [1], saved: [], reverted: [] });
});

test('save, then undo back to the original: orange (reverted)', () => {
    const orig = L('a\nb\nc');
    const saved = L('a\nB\nc');
    const r = classify(orig, saved, orig);
    assert.deepEqual(r, { unsaved: [], saved: [], reverted: [1] });
});

test('reverted then saved: no marks', () => {
    const orig = L('a\nb\nc');
    const r = classify(orig, orig, orig);
    assert.deepEqual(r, { unsaved: [], saved: [], reverted: [] });
});
