import { spawn } from 'node:child_process';

export const REPORT_FORM = 'https://github.com/egzey0/svietlik/issues/new?template=car-report.yml';

// GitHub gives up somewhere past 8k characters of URL
const MAX_URL = 7000;

/**
 * Link to the car report form with what we know filled in. Issue forms take
 * field ids as query parameters. A full scan is too long for a URL, then the
 * report box stays empty and the user pastes it from the clipboard.
 */
export function reportUrl(report: string, car?: string): { url: string; withReport: boolean } {
  const params = new URLSearchParams({ template: 'car-report.yml' });
  if (car) {
    params.set('title', `car: ${car}`);
    params.set('car', car);
  }
  const base = `https://github.com/egzey0/svietlik/issues/new?${params}`;
  const full = `${base}&report=${encodeURIComponent(report)}`;
  return full.length <= MAX_URL ? { url: full, withReport: true } : { url: base, withReport: false };
}

function run(cmd: string, args: string[], input?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'] });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    if (input !== undefined) child.stdin?.end(input);
  });
}

export function openUrl(url: string): Promise<boolean> {
  // `start` would go through cmd and cut the URL at the first &
  if (process.platform === 'win32') return run('rundll32', ['url.dll,FileProtocolHandler', url]);
  return run(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
}

export async function copyText(text: string): Promise<boolean> {
  if (process.platform === 'win32') return run('clip', [], text);
  if (process.platform === 'darwin') return run('pbcopy', [], text);
  return (await run('wl-copy', [], text)) || run('xclip', ['-selection', 'clipboard'], text);
}
