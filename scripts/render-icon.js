// Renders images/icon.svg to images/icon.png (256x256, transparent) with a
// headless Chromium browser (Microsoft Edge or Chrome). VS Code extension
// icons must be PNG.
//
//   node scripts/render-icon.js            -> images/icon.png
//   node scripts/render-icon.js --preview  -> also images/icon-preview.png
//
// Set BROWSER to the browser executable if it is not found automatically.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const svgPath = path.join(root, 'images', 'icon.svg');

function findBrowser() {
    const candidates = [
        process.env.BROWSER,
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
    ];
    const found = candidates.find((p) => p && fs.existsSync(p));
    if (!found) {
        throw new Error('No Edge or Chrome found; set BROWSER to its executable.');
    }
    return found;
}

function screenshot(browser, html, width, height, out) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-icon-'));
    const htmlPath = path.join(dir, 'page.html');
    fs.writeFileSync(htmlPath, html);
    try {
        execFileSync(browser, [
            '--headless=new',
            '--disable-gpu',
            '--hide-scrollbars',
            '--force-device-scale-factor=1',
            '--default-background-color=00000000',
            `--user-data-dir=${path.join(dir, 'profile')}`,
            `--window-size=${width},${height}`,
            `--screenshot=${out}`,
            'file:///' + htmlPath.replace(/\\/g, '/'),
        ], { stdio: 'ignore', timeout: 60000 });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('wrote', path.relative(root, out));
}

const browser = findBrowser();
const svg = fs.readFileSync(svgPath, 'utf8');
const dataUri = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
const page = (body, bg = 'transparent') =>
    `<!doctype html><html><body style="margin:0;background:${bg}">${body}</body></html>`;

screenshot(
    browser,
    page(`<img src="${dataUri}" width="256" height="256" style="display:block">`),
    256,
    256,
    path.join(root, 'images', 'icon.png'),
);

if (process.argv.includes('--preview')) {
    const sizes = [128, 64, 32, 16];
    const row = (bg) =>
        `<div style="display:flex;align-items:flex-end;gap:24px;padding:20px;background:${bg}">` +
        sizes.map((s) => `<img src="${dataUri}" width="${s}" height="${s}">`).join('') +
        '</div>';
    screenshot(
        browser,
        page(row('#ffffff') + row('#1e1e1e') + row('#f3f3f3')),
        360,
        3 * 168,
        path.join(root, 'images', 'icon-preview.png'),
    );
}
