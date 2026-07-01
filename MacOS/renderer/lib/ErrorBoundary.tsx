/* ErrorBoundary — stops a single component's render error from blanking the
   entire window. Without one, ANY uncaught throw during render (a weird stream
   chunk, a null transcript, an attachment shape we didn't expect) unmounts the
   whole React tree and the screen goes white — the "window blanks" symptom.

   This boundary shows a small recovery card with the error message + a Reload
   button instead, and mirrors the error to the console so it's diagnosable.
   Use it high in the tree (App) as a safety net, and around self-contained
   surfaces (a chat pane) so one bad turn doesn't take down the workspace. */

import React from 'react';

interface Props {
  children: React.ReactNode;
  /** Optional label for where the error happened (logged + shown). */
  name?: string;
  /** Custom fallback render. Defaults to the recovery card. */
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(`[ErrorBoundary${this.props.name ? `:${this.props.name}` : ''}]`, error, info.componentStack);
  }

  reset = (): void => { this.setState({ error: null }); };

  render(): React.ReactNode {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.state.error, this.reset);
      const msg = this.state.error.message || String(this.state.error);
      return (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', padding: 28, background: 'var(--backdrop-base, #f6f6f8)', textAlign: 'center' }}>
          <div style={{ maxWidth: 420 }}>
            <div style={{ width: 46, height: 46, borderRadius: 12, margin: '0 auto 14px', display: 'grid', placeItems: 'center',
              background: 'color-mix(in srgb, var(--red, #ff3b30) 14%, transparent)', color: 'var(--red, #ff3b30)' }}>
              <span style={{ font: '700 22px/1 var(--font-text, system-ui)' }}>!</span>
            </div>
            <div style={{ font: '700 17px/1.3 var(--font-text, system-ui)', color: 'var(--ink, #000)', marginBottom: 6 }}>Something went wrong rendering this view</div>
            <div style={{ font: '400 13px/1.5 var(--font-text, system-ui)', color: 'var(--ink-secondary, #555)', marginBottom: 4 }}>
              The app kept running — reload the view to recover. Your chats and work are untouched.
            </div>
            <div style={{ font: '400 11px/1.4 var(--font-mono, ui-monospace)', color: 'var(--ink-tertiary, #888)', marginBottom: 16,
              whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 120, overflow: 'auto' }}>{msg}</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button onClick={this.reset} style={{ height: 34, padding: '0 16px', borderRadius: 9, border: 'none', cursor: 'pointer',
                background: 'var(--blue, #3b82f6)', color: '#fff', font: '600 13px/1 var(--font-text, system-ui)' }}>Try again</button>
              <button onClick={() => location.reload()} style={{ height: 34, padding: '0 16px', borderRadius: 9, cursor: 'pointer',
                background: 'var(--fill-secondary, #e5e5ea)', color: 'var(--ink, #000)', border: '0.5px solid var(--separator, #d1d1d6)',
                font: '600 13px/1 var(--font-text, system-ui)' }}>Reload app</button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
