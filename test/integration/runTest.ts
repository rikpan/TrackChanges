/**
 * Launches VS Code with this extension and runs ./suite inside it.
 *
 * Uses the VS Code at $VSCODE_EXE, or the usual install location on Windows,
 * or downloads one. A fresh profile is used, so the normal VS Code setup and
 * any installed copy of this extension are not touched.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

function findInstalledCode(): string | undefined {
    const candidates = [
        process.env.VSCODE_EXE,
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
        '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    ];
    return candidates.find((p): p is string => !!p && fs.existsSync(p));
}

async function main(): Promise<void> {
    const root = path.resolve(__dirname, '../../..');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'track-changes-test-'));
    const workspace = path.join(tmp, 'workspace');
    fs.mkdirSync(workspace);
    try {
        await runTests({
            vscodeExecutablePath: findInstalledCode(),
            extensionDevelopmentPath: root,
            extensionTestsPath: path.join(__dirname, 'suite'),
            launchArgs: [
                workspace,
                '--disable-extensions',
                '--disable-workspace-trust',
                '--skip-welcome',
                '--skip-release-notes',
                '--user-data-dir',
                path.join(tmp, 'user-data'),
                '--extensions-dir',
                path.join(tmp, 'extensions'),
            ],
        });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
