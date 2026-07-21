// Pure display formatter for the runtime identity footer. Maps the health
// response's { channel, version } to the app NAME + a human version label, so the
// UI can show which build is actually running (Production / Preview / Development)
// without ever fabricating a version. Keep this pure (no React / network) so it is
// unit-testable and reusable.

export type ReleaseChannel = 'production' | 'preview' | 'development';

const CHANNEL_NAME: Record<ReleaseChannel, string> = {
  production: 'Mochlet',
  preview: 'Mochlet Preview',
  development: 'Mochlet Development',
};

export interface RuntimeIdentity {
  channel: ReleaseChannel;
  name: string;
  versionLabel: string;
  ariaLabel: string;
}

/** Validate an arbitrary channel string; unknown / missing → production (matches
 *  the server-side health validation). */
export function normalizeChannel(channel?: string | null): ReleaseChannel {
  return channel === 'preview' || channel === 'development' ? channel : 'production';
}

/** Format the identity for the footer. A missing/blank version yields an honest
 *  "Version unavailable" — never a placeholder number. */
export function formatRuntimeIdentity(input: { channel?: string | null; version?: string | null }): RuntimeIdentity {
  const channel = normalizeChannel(input.channel);
  const name = CHANNEL_NAME[channel];
  const version = typeof input.version === 'string' ? input.version.trim() : '';
  const versionLabel = version ? `Version ${version}` : 'Version unavailable';
  const ariaLabel = version
    ? `Running ${name}, version ${version}`
    : `Running ${name}, version unavailable`;
  return { channel, name, versionLabel, ariaLabel };
}
