import { describe, it, expect } from 'vitest';
import { classifyBashCommand, bgRedirectReason, BG_RUN_IN_BACKGROUND_DENY } from './bg-command-guard.js';

describe('classifyBashCommand — redirect long-lived / backgrounded shells', () => {
  it("redirects the SDK Bash tool's own run_in_background flag", () => {
    // Even a normally-fine command must go through our tool when the model asks
    // Bash to background it — that shell is a child of the per-turn subprocess.
    const v = classifyBashCommand('echo hello', true);
    expect(v.redirect).toBe(true);
    expect(v.rule).toBe('sdk-background');
  });

  it.each([
    'npm run dev',
    'pnpm dev',
    'pnpm dev:api',
    'yarn start',
    'bun run serve',
    'npm run watch',
    'next dev',
    'next start -p 3001',
    'vite',
    'vite --host 0.0.0.0',
    'expo start',
    'nodemon server.js',
    'tsx watch src/index.ts',
    'node --watch app.js',
    'tsc --watch',
    'vitest --watch',
    'tail -f logs/app.log',
    'uvicorn main:app --reload',
    'gunicorn app:app',
    'flask run',
    'python manage.py runserver',
    'python -m http.server 8000',
    'rails s',
    'php artisan serve',
    'php -S localhost:8000',
    'docker compose up',
    'docker-compose up web',
  ])('redirects long-lived command: %s', (cmd) => {
    const v = classifyBashCommand(cmd);
    expect(v.redirect).toBe(true);
    expect(v.rule).toBe('long-lived');
  });

  it.each([
    'pnpm dev &',
    'nohup node server.js',
    'node server.js & disown',
    'setsid ./run.sh',
    'python app.py &',
  ])('redirects shell-backgrounded command: %s', (cmd) => {
    const v = classifyBashCommand(cmd);
    expect(v.redirect).toBe(true);
    // `pnpm dev &` matches BOTH rules; shell-background is checked first.
    expect(['shell-background', 'long-lived']).toContain(v.rule);
  });

  it.each([
    'npm install',
    'pnpm install --frozen-lockfile',
    'npm run build',
    'pnpm build',
    'vite build',
    'next build',
    'npm test',
    'pnpm run test',
    'vitest run',
    'git status',
    'git add -A && git commit -m "wip"',
    'ls -la',
    'cat package.json',
    'echo "done" 2>&1',
    'grep -rn foo src && echo ok',
    'mkdir -p dist && cp a b',
    'node scripts/gen.js',
    'tsc --noEmit',
    'curl -s http://localhost:3000/health',
  ])('leaves quick command in the foreground: %s', (cmd) => {
    const v = classifyBashCommand(cmd);
    expect(v.redirect).toBe(false);
    expect(v.rule).toBeUndefined();
  });

  it('does not treat `&&`, `2>&1`, or `&>` as backgrounding', () => {
    expect(classifyBashCommand('a && b').redirect).toBe(false);
    expect(classifyBashCommand('node x.js > out.log 2>&1').redirect).toBe(false);
    expect(classifyBashCommand('node x.js &> out.log').redirect).toBe(false);
  });

  it('handles empty / whitespace commands safely', () => {
    expect(classifyBashCommand('').redirect).toBe(false);
    expect(classifyBashCommand('   ').redirect).toBe(false);
  });

  it('does not redirect `vite build` (build is not a server)', () => {
    expect(classifyBashCommand('vite build').redirect).toBe(false);
    expect(classifyBashCommand('npx vite build --mode prod').redirect).toBe(false);
  });

  it('redirects a detached docker compose only when NOT -d', () => {
    expect(classifyBashCommand('docker compose up').redirect).toBe(true);
    expect(classifyBashCommand('docker compose up -d').redirect).toBe(false);
    expect(classifyBashCommand('docker-compose up --detach').redirect).toBe(false);
  });
});

describe('bgRedirectReason', () => {
  it('names the run_in_background tool and explains the turn-death', () => {
    const msg = bgRedirectReason('pnpm dev', 'long-lived');
    expect(msg).toContain('run_in_background');
    expect(msg).toContain('pnpm dev');
    expect(msg.toLowerCase()).toContain('cancel');
  });

  it('truncates a very long command in the message', () => {
    const long = 'node ' + 'x'.repeat(300);
    const msg = bgRedirectReason(long, 'shell-background');
    expect(msg).toContain('…');
  });
});

describe('BG_RUN_IN_BACKGROUND_DENY', () => {
  it('mentions the Maestro tool the agent must retry with', () => {
    expect(BG_RUN_IN_BACKGROUND_DENY).toContain('mcp__maestro__run_in_background');
  });

  it('explains WHY (killed on steer / force-send)', () => {
    expect(BG_RUN_IN_BACKGROUND_DENY.length).toBeGreaterThan(80);
    expect(BG_RUN_IN_BACKGROUND_DENY.toLowerCase()).toContain('killed');
  });
});
