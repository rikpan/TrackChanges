/**
 * Integration tests: drive a real editor with VS Code's own commands
 * (type, deleteLeft, undo, redo, save) and check the extension's marks.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

interface Marks {
    unsaved: number[];
    saved: number[];
    reverted: number[];
}

const CONTENT = 'line0\nline1\nline2\nline3';
const none: Marks = { unsaved: [], saved: [], reverted: [] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fileCounter = 0;

async function openFresh(): Promise<vscode.TextEditor> {
    const dir = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const file = path.join(dir, `test${fileCounter++}.txt`);
    fs.writeFileSync(file, CONTENT);
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(doc);
    await sleep(50);
    return editor;
}

function cursor(editor: vscode.TextEditor, line: number, ch: number): void {
    editor.selection = new vscode.Selection(line, ch, line, ch);
}

async function exec(command: string, args?: unknown): Promise<void> {
    await vscode.commands.executeCommand(command, args);
    await sleep(40);
}

const type = (text: string) => exec('type', { text });
const undo = () => exec('undo');
const redo = () => exec('redo');

async function save(editor: vscode.TextEditor): Promise<void> {
    await editor.document.save();
    await sleep(40);
}

async function marks(editor: vscode.TextEditor): Promise<Marks> {
    return (await vscode.commands.executeCommand<Marks>('trackChanges._marks', editor.document.uri))!;
}

async function expectMarks(editor: vscode.TextEditor, expected: Partial<Marks>, step: string): Promise<void> {
    assert.deepStrictEqual(await marks(editor), { ...none, ...expected }, step);
}

const tests: [string, () => Promise<void>][] = [
    ['opening a file shows no marks', async () => {
        const e = await openFresh();
        await expectMarks(e, {}, 'opened');
    }],

    ['Enter at end of line marks the cursor line and the new line; undo clears', async () => {
        const e = await openFresh();
        cursor(e, 1, 5);
        await type('\n');
        await expectMarks(e, { unsaved: [1, 2] }, 'after Enter');
        await undo();
        assert.strictEqual(e.document.getText(), CONTENT);
        await expectMarks(e, {}, 'after undo');
    }],

    ['Enter in the middle of a line marks both halves', async () => {
        const e = await openFresh();
        cursor(e, 1, 2);
        await type('\n');
        await expectMarks(e, { unsaved: [1, 2] }, 'after Enter');
    }],

    ['grouped typing undone in one Ctrl+Z clears the marks', async () => {
        const e = await openFresh();
        cursor(e, 1, 5);
        await type('a');
        await type('b');
        await type('c');
        await expectMarks(e, { unsaved: [1] }, 'after typing');
        await undo();
        assert.strictEqual(e.document.getText(), CONTENT, 'one undo removed all three characters');
        await expectMarks(e, {}, 'after undo');
    }],

    ['typing then Backspace stays yellow', async () => {
        const e = await openFresh();
        cursor(e, 1, 5);
        await type('x');
        await exec('deleteLeft');
        assert.strictEqual(e.document.getText(), CONTENT);
        await expectMarks(e, { unsaved: [1] }, 'after Backspace');
    }],

    ['save turns green, undo turns reverted, redo turns green', async () => {
        const e = await openFresh();
        cursor(e, 1, 5);
        await type('x');
        await save(e);
        await expectMarks(e, { saved: [1] }, 'after save');
        await undo();
        await expectMarks(e, { reverted: [1] }, 'after undo');
        await redo();
        await expectMarks(e, { saved: [1] }, 'after redo');
    }],

    ['save, undo, save leaves no marks', async () => {
        const e = await openFresh();
        cursor(e, 1, 5);
        await type('x');
        await save(e);
        await undo();
        await save(e);
        await expectMarks(e, {}, 'after second save');
    }],

    ['Enter, save, undo: cursor line reverted; save: no marks', async () => {
        const e = await openFresh();
        cursor(e, 1, 5);
        await type('\n');
        await save(e);
        await expectMarks(e, { saved: [1, 2] }, 'after save');
        await undo();
        await expectMarks(e, { reverted: [1] }, 'after undo');
        await save(e);
        await expectMarks(e, {}, 'after second save');
    }],

    ['unsaved change on top of a saved one: undo returns to green', async () => {
        const e = await openFresh();
        cursor(e, 1, 5);
        await type('x');
        await save(e);
        cursor(e, 1, 6);
        await type('y');
        await expectMarks(e, { unsaved: [1] }, 'after second edit');
        await undo();
        await expectMarks(e, { saved: [1] }, 'after undo');
    }],

    ['two saves, undo twice: both reverted', async () => {
        const e = await openFresh();
        cursor(e, 0, 5);
        await type('a');
        await save(e);
        cursor(e, 2, 5);
        await type('b');
        await save(e);
        await expectMarks(e, { saved: [0, 2] }, 'after saves');
        await undo();
        await expectMarks(e, { saved: [0], reverted: [2] }, 'after first undo');
        await undo();
        await expectMarks(e, { reverted: [0, 2] }, 'after second undo');
    }],

    ['multi-cursor typing marks each line; undo clears', async () => {
        const e = await openFresh();
        e.selections = [new vscode.Selection(1, 0, 1, 0), new vscode.Selection(3, 0, 3, 0)];
        await type('#');
        await expectMarks(e, { unsaved: [1, 3] }, 'after typing');
        await undo();
        await expectMarks(e, {}, 'after undo');
    }],

    ['deleting a line marks where it was; undo clears', async () => {
        const e = await openFresh();
        cursor(e, 1, 0);
        await exec('editor.action.deleteLines');
        assert.strictEqual(e.document.getText(), 'line0\nline2\nline3');
        await expectMarks(e, { unsaved: [1] }, 'after delete');
        await undo();
        await expectMarks(e, {}, 'after undo');
    }],

    ['Go to Next/Previous Change jumps between changed blocks', async () => {
        const e = await openFresh();
        cursor(e, 1, 5);
        await type('x');
        cursor(e, 3, 5);
        await type('y');
        cursor(e, 0, 0);
        await exec('trackChanges.nextChange');
        assert.strictEqual(e.selection.active.line, 1);
        await exec('trackChanges.nextChange');
        assert.strictEqual(e.selection.active.line, 3);
        await exec('trackChanges.previousChange');
        assert.strictEqual(e.selection.active.line, 1);
    }],

    ['reset clears all marks', async () => {
        const e = await openFresh();
        cursor(e, 1, 5);
        await type('x');
        await save(e);
        cursor(e, 2, 5);
        await type('y');
        await exec('trackChanges.reset');
        await expectMarks(e, {}, 'after reset');
    }],
];

export async function run(): Promise<void> {
    const failures: string[] = [];
    for (const [name, fn] of tests) {
        try {
            await fn();
            console.log(`  ok    ${name}`);
        } catch (err) {
            failures.push(name);
            console.log(`  FAIL  ${name}\n        ${String((err as Error).message).replace(/\n/g, '\n        ')}`);
        }
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
    console.log(`\n  ${tests.length - failures.length} passed, ${failures.length} failed`);
    if (failures.length > 0) {
        throw new Error(`${failures.length} integration test(s) failed`);
    }
}
