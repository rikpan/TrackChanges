import * as vscode from 'vscode';
import { Language, message, MessageKey, resolveLanguage } from './i18n';
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
    markerWidth: number;
    showInOverviewRuler: boolean;
    maxFileLines: number;
    debounceMs: number;
    language: Language;
}

function readConfig(): Config {
    const c = vscode.workspace.getConfiguration('trackChanges');
    return {
        enabled: c.get('enabled', true),
        unsavedColor: c.get('unsavedColor', '#EFD700'),
        savedColor: c.get('savedColor', '#57A64A'),
        revertedColor: c.get('revertedColor', '#3E8FD8'),
        markerWidth: Math.min(16, Math.max(1, c.get('markerWidth', 3))),
        showInOverviewRuler: c.get('showInOverviewRuler', true),
        maxFileLines: c.get('maxFileLines', 100000),
        debounceMs: c.get('debounceMs', 0),
        language: resolveLanguage(c.get<string>('language'), vscode.env.language),
    };
}

/**
 * A vertical bar on the right edge of the gutter, stretched to the full line height.
 * `width` is in sixteenths of the gutter icon area (about one pixel each).
 * `hatched` draws it with diagonal stripes, as Visual Studio does for reverted changes.
 */
function barIcon(color: string, width: number, hatched = false): vscode.Uri {
    const rect = `x="${16 - width}" y="0" width="${width}" height="16"`;
    const bar = hatched
        ? '<defs><pattern id="h" width="2.5" height="2.5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
          `<rect width="1.25" height="2.5" fill="${color}"/></pattern></defs>` +
          `<rect ${rect} fill="${color}" fill-opacity="0.45"/>` +
          `<rect ${rect} fill="url(#h)"/>`
        : `<rect ${rect} fill="${color}"/>`;
    const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" preserveAspectRatio="none">' +
        bar +
        '</svg>';
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
            // Not in package.json, so not in the Command Palette; used by the integration tests.
            vscode.commands.registerCommand('trackChanges._marks', (uri?: vscode.Uri) => {
                const doc = uri
                    ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())
                    : vscode.window.activeTextEditor?.document;
                return doc ? this.classification(doc) : undefined;
            }),
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
        const tracker = state.tracker;
        if (e.reason === vscode.TextDocumentChangeReason.Undo) {
            tracker.undo(changes, hash);
        } else if (e.reason === vscode.TextDocumentChangeReason.Redo) {
            tracker.redo(changes, hash);
        } else {
            tracker.edit(changes, hash);
            if (doc.uri.scheme !== 'untitled') {
                this.checkReplacedFromDisk(doc, state);
            }
        }
        tracker.sync(doc.lineCount);
        this.scheduleRender(doc, state);
    }

    /**
     * "Revert File" or a reload after an external change replaces the content
     * with what is on disk, leaving the document not dirty: treat it as a save.
     *
     * `isDirty` cannot be read during the change event: on the first edit after
     * opening or saving it can still be false, which would turn a normal edit
     * green. So check once it has settled, and only if nothing changed since.
     */
    private checkReplacedFromDisk(doc: vscode.TextDocument, state: DocState): void {
        const version = doc.version;
        setTimeout(() => {
            if (this.docs.get(doc.uri.toString()) === state && doc.version === version && !doc.isDirty) {
                state.tracker.save();
                this.renderDoc(doc);
            }
        }, 100);
    }

    private scheduleRender(doc: vscode.TextDocument, state: DocState): void {
        if (state.timer) {
            clearTimeout(state.timer);
            state.timer = undefined;
        }
        if (this.config.debounceMs <= 0) {
            this.renderDoc(doc); // same tick as the edit, so marks never lag behind
            return;
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
        const make = (color: string, hatched = false) =>
            vscode.window.createTextEditorDecorationType({
                isWholeLine: true,
                gutterIconPath: barIcon(color, this.config.markerWidth, hatched),
                gutterIconSize: 'cover',
                overviewRulerColor: this.config.showInOverviewRuler ? color : undefined,
                overviewRulerLane: vscode.OverviewRulerLane.Left,
                rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
            });
        this.types = {
            unsaved: make(this.config.unsavedColor),
            saved: make(this.config.savedColor),
            reverted: make(this.config.revertedColor, true),
        };
    }

    private disposeDecorationTypes(): void {
        Object.values(this.types).forEach((t) => t.dispose());
    }

    // ---- commands -----------------------------------------------------------

    private t(key: MessageKey): string {
        return message(key, this.config.language);
    }

    private async toggle(): Promise<void> {
        const config = vscode.workspace.getConfiguration('trackChanges');
        const next = !config.get('enabled', true);
        await config.update('enabled', next, vscode.ConfigurationTarget.Global);
        vscode.window.setStatusBarMessage(this.t(next ? 'enabled' : 'disabled'), 2000);
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
            vscode.window.setStatusBarMessage(this.t('noChanges'), 2000);
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
