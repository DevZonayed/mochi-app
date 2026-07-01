/* Shared types for the Playwright-backed browser. Kept dependency-free (no
   electron, no playwright import) so both the Electron main and the headless
   sidecar — and the unit tests with a fake launcher — consume them cleanly. */

export interface BrowserSettings {
  enabled: boolean;
  headless: boolean;
  /** Override the Chrome binary; otherwise Playwright `channel:'chrome'` auto-detects. */
  chromePath?: string;
  defaultStartUrl?: string;
  windowWidth?: number;
  windowHeight?: number;
}

export interface BrowserStatus {
  projectId: string;
  open: boolean;
  url: string | null;
  title: string | null;
  tabCount: number;
  lastScreenshotAt: number | null;
  chromeVersion: string | null;
  /** Set when a launch/operation failed (e.g. 'chrome-launch-failed: …'). */
  error?: string;
}

export interface OpenOpts { startUrl?: string }

/** The slice of a Playwright Page the manager drives. Real Playwright Pages
    satisfy this structurally; tests pass a fake. */
export interface PwPageLike {
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  screenshot(opts?: Record<string, unknown>): Promise<Buffer>;
  bringToFront(): Promise<void>;
  evaluate?(fn: unknown, arg?: unknown): Promise<unknown>;
  on?(event: string, cb: (...a: unknown[]) => void): void;
}

/** The slice of a Playwright BrowserContext the manager drives. */
export interface PwContextLike {
  pages(): PwPageLike[];
  newPage(): Promise<PwPageLike>;
  close(): Promise<void>;
  on(ev: 'close', cb: () => void): void;
  browser(): { version(): string } | null;
  addInitScript(script: string): Promise<void>;
  exposeBinding(name: string, cb: (source: unknown, payload: any) => unknown): Promise<void>;
  newCDPSession?(page: PwPageLike): Promise<{ send(method: string, params?: unknown): Promise<unknown> }>;
}

export interface Launcher {
  launchPersistentContext(dir: string, opts: Record<string, unknown>): Promise<PwContextLike>;
}

export interface BrowserManagerDeps {
  userDataDir: string;
  settings: () => BrowserSettings;
  /** Round-trips comment/steer back into the brain (addDesignComment / sendChat). */
  dispatch: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /** Pushed on every state change → emit('browser', status) to the app. */
  emit: (status: BrowserStatus) => void;
  /** Injectable for tests; defaults to playwright-core chromium. */
  launcher?: Launcher;
}
