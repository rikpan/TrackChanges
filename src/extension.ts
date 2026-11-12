import * as vscode from 'vscode';
import { hashText, LineTracker, Marks, TextChange } from './tracker';

const TRACKED_SCHEMES = new Set(['file', 'untitled', 'vscode-remote', 'vscode-vfs', 'vscode-userdata']);

interface DocState {
    tracker: LineTracker;
    timer?: ReturnType<typeof setTimeout>;
}

interface Config {
    enabled: boolean;
    unsavedColor: string;
    savedColor: string;
    revertedColor: string;
    showInOverviewRuler: boolean;
    maxFileLines: number;
    debounceMs: number;
}

function readConfig(): Config {
    const c = vscode.workspace.getConfiguration('trackChanges');
    return {
        enabled: c.get('enabled', true),
        unsavedColor: c.get('unsavedColor', '#EFD700'),
        savedColor: c.get('savedColor', '#57A64A'),
        revertedColor: c.get('revertedColor', '#F2A33A'),
        showInOverviewRuler: c.get('showInOverviewRuler', true),
        maxFileLines: c.get('maxFileLines', 100000),
        debounceMs: c.get('debounceMs', 150),
    };
}

/** A vertical bar on the right edge of the gutter, stretched to the full line height. */
function barIcon(color: string): vscode.Uri {
    const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" preserveAspectRatio="none">' +
        `<rect x="11" y="0" width="5" height="16" fill="${color}"/></svg>`;
    return vscode.Uri.parse('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
}

class TrackChanges implements vscode.Disposable {
    private readonly docs = new Map<string, DocState>();
    private readonly disposables: vscode.Disposable[] = [];
    private config = readConfig();
    private types!: Record<keyof Marks, vscode.TextEditorDecorationType>;

    constructor() {
        this.createDecorationTypes();

        for (const doc of vscode.workspace.textDocuments) {
            this.track(doc);
        }

        this.disposables.push(
            vscode.workspace.onDidOpenTextDocument((doc) => this.track(doc)),
            vscode.workspace.onDidCloseTextDocument((doc) => this.untrack(doc)),
            vscode.workspace.onDidSaveTextDocument((doc) => this.onSaved(doc)),
            vscode.workspace.onDidChangeTextDocument((e) => this.onChanged(e)),
            vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach((ed) => this.render(ed))),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('trackChanges')) {
                    this.config = readConfig();
                    this.disposeDecorationTypes();
                    this.createDecorationTypes();
                    this.renderAll();
                }
            }),
            vscode.commands.registerCommand('trackChanges.toggle', () => this.toggle()),
            vscode.commands.registerCommand('trackChanges.reset', () => this.resetActive()),
            vscode.commands.registerCommand('trackChanges.resetAll', () => this.resetAll()),
            vscode.commands.registerCommand('trackChanges.nextChange', () => this.goToChange(1)),
            vscode.commands.registerCommand('trackChanges.previousChange', () => this.goToChange(-1)),
        );

        this.renderAll();
    }

    // ---- document lifecycle -------------------------------------------------

    private track(doc: vscode.TextDocument): void {
        const key = doc.uri.toString();
        if (!TRACKED_SCHEMES.has(doc.uri.scheme) || this.docs.has(key) || doc.lineCount > this.config.maxFileLines) {
            return;
        }
        // Like Visual Studio, tracking starts clean when the file is opened.
        this.docs.set(key, { tracker: new LineTracker(doc.lineCount, hashText(doc.getText())) });
    }

    private untrack(doc: vscode.TextDocument): void {
        const key = doc.uri.toString();
        const state = this.docs.get(key);
        if (state?.timer) {
            clearTimeout(state.timer);
        }
        this.docs.delete(key);
    }

    private onSaved(doc: vscode.TextDocument): void {
        const state = this.docs.get(doc.uri.toString());
        if (!state) {
            return;
        }
        state.tracker.save();
        this.renderDoc(doc);
    }

    private onChanged(e: vscode.TextDocumentChangeEvent): void {
        const doc = e.document;
        const state = this.docs.get(doc.uri.toString());
        if (!state || e.contentChanges.length === 0) {
            return;
        }
        if (doc.lineCount > this.config.maxFileLines) {
            this.untrack(doc);
            this.renderDoc(doc);
            return;
        }
        const changes: TextChange[] = e.contentChanges.map((c) => ({
            startLine: c.range.start.line,
            startChar: c.range.start.character,
            endLine: c.range.end.line,
            endChar: c.range.end.character,
            text: c.text,
        }));
        const hash = hashText(doc.getText());
        const lineAt = (line: number) => (line < doc.lineCount ? doc.lineAt(line).text : '');
        const tracker = state.tracker;
        if (e.reason === vscode.TextDocumentChangeReason.Undo) {
            tracker.undo(changes, hash, lineAt);
        } else if (e.reason === vscode.TextDocumentChangeReason.Redo) {
            tracker.redo(changes, hash, lineAt);
        } else {
            tracker.edit(changes, hash, lineAt);
            // Content replaced from disk ("Revert File", reload after an external change).
            if (!doc.isDirty && doc.uri.scheme !== 'untitled') {
                tracker.save();
            }
        }
        tracker.sync(doc.lineCount);
        this.scheduleRender(doc, state);
    }

    private scheduleRender(doc: vscode.TextDocument, state: DocState): void {
        if (state.timer) {
            clearTimeout(state.timer);
        }
        state.timer = setTimeout(() => {
            state.timer = undefined;
            this.renderDoc(doc);
        }, this.config.debounceMs);
    }

    // ---- classification & rendering ---------------------------------------

    private classification(doc: vscode.TextDocument): Marks | undefined {
        return this.docs.get(doc.uri.toString())?.tracker.marks();
    }

    private renderDoc(doc: vscode.TextDocument): void {
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document === doc) {
                this.render(editor);
            }
        }
    }

    private renderAll(): void {
        vscode.window.visibleTextEditors.forEach((ed) => this.render(ed));
    }

    private render(editor: vscode.TextEditor): void {
        const result = this.config.enabled ? this.classification(editor.document) : undefined;
        for (const kind of Object.keys(this.types) as (keyof Marks)[]) {
            const ranges = result ? result[kind].map((line) => new vscode.Range(line, 0, line, 0)) : [];
            editor.setDecorations(this.types[kind], ranges);
        }
    }

    private createDecorationTypes(): void {
        const make = (color: string) =>
            vscode.window.createTextEditorDecorationType({
                isWholeLine: true,
                gutterIconPath: barIcon(color),
                gutterIconSize: 'cover',
                overviewRulerColor: this.config.showInOverviewRuler ? color : undefined,
                overviewRulerLane: vscode.OverviewRulerLane.Left,
                rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
            });
        this.types = {
            unsaved: make(this.config.unsavedColor),
            saved: make(this.config.savedColor),
            reverted: make(this.config.revertedColor),
        };
    }

    private disposeDecorationTypes(): void {
        Object.values(this.types).forEach((t) => t.dispose());
    }

    // ---- commands -----------------------------------------------------------

    private async toggle(): Promise<void> {
        const config = vscode.workspace.getConfiguration('trackChanges');
        const next = !config.get('enabled', true);
        await config.update('enabled', next, vscode.ConfigurationTarget.Global);
        vscode.window.setStatusBarMessage(`Track Changes ${next ? 'enabled' : 'disabled'}`, 2000);
    }

    /** Clear all marks, as if the file had just been opened. */
    private reset(doc: vscode.TextDocument): void {
        const state = this.docs.get(doc.uri.toString());
        if (state) {
            state.tracker.reset();
            this.renderDoc(doc);
        }
    }

    private resetActive(): void {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            this.reset(editor.document);
        }
    }

    private resetAll(): void {
        for (const doc of vscode.workspace.textDocuments) {
            this.reset(doc);
        }
    }

    private goToChange(direction: 1 | -1): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !this.config.enabled) {
            return;
        }
        const result = this.classification(editor.document);
        if (!result) {
            return;
        }
        const marked = new Set([...result.unsaved, ...result.saved, ...result.reverted]);
        // Start line of each contiguous block of marked lines.
        const starts = [...marked].filter((l) => !marked.has(l - 1)).sort((a, b) => a - b);
        if (starts.length === 0) {
            vscode.window.setStatusBarMessage('Track Changes: no changes in this file', 2000);
            return;
        }

        let cursor = editor.selection.active.line;
        // Inside a block, treat the cursor as being at the block's start.
        while (marked.has(cursor - 1) && marked.has(cursor)) {
            cursor--;
        }
        let target: number;
        if (direction === 1) {
            target = starts.find((l) => l > cursor) ?? starts[0];
        } else {
            const before = starts.filter((l) => l < cursor);
            target = before.length > 0 ? before[before.length - 1] : starts[starts.length - 1];
        }
        const pos = new vscode.Position(target, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    dispose(): void {
        for (const state of this.docs.values()) {
            if (state.timer) {
                clearTimeout(state.timer);
            }
        }
        this.docs.clear();
        this.disposeDecorationTypes();
        this.disposables.forEach((d) => d.dispose());
    }
}

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(new TrackChanges());
}

export function deactivate(): void {
    // Everything is disposed through context.subscriptions.
}
