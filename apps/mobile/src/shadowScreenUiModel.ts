/* shadowScreenUiModel — Phase 3D1 pure view-model for the mobile Screen viewer.
 *
 * Maps the (capability granted? / online? / stream client phase) triple into ONE
 * truthful UI phase + the exact copy/affordances the screen shows. Pure (no RN, no
 * time, no IO) so it is Node-testable and the screen renders deterministically. It
 * NEVER fabricates a "live" state — that only comes from the client having decoded a
 * real frame. No raw ids/keys/latency internals are ever surfaced. */

import type { ScreenClientPhase, ScreenClientState } from './shadowScreenClient';

export type ScreenUiPhase =
  | 'no-cap'
  | 'offline'
  | 'idle'
  | 'requesting'
  | 'live'
  | 'permission-required'
  | 'permission-denied'
  | 'busy'
  | 'source-lost'
  | 'source-required'
  | 'error'
  | 'revoked'
  | 'expired';

export interface ScreenUiInputs {
  readonly screenViewGranted: boolean;
  readonly online: boolean;
  readonly client: Pick<ScreenClientState, 'phase' | 'sourceLabel' | 'reason' | 'latestFrame' | 'width' | 'height'>;
  readonly hostName: string;
  readonly configuredSourceLabel: string | null;
  /** B1-R1: whether a live production client is attached. When granted+online but not
   * yet attached the "View screen" button is HIDDEN (a "Preparing…" state shows instead)
   * so a tap can never be a silent no-op against a null client. Defaults to true for
   * pure-model callers/tests that don't model attachment. */
  readonly attached?: boolean;
}

export interface ScreenViewModel {
  readonly phase: ScreenUiPhase;
  readonly title: string;
  readonly subtitle: string;
  /** The standing "view only" reassurance, shown wherever an action is offered. */
  readonly viewOnlyNote: string;
  readonly showViewButton: boolean;
  readonly showStopButton: boolean;
  readonly showFrame: boolean;
  readonly sourceLabel: string | null;
  /** The accessible label for the live frame surface (no OCR/title leak). */
  readonly frameAccessibilityLabel: string;
  readonly statusTone: 'online' | 'offline' | 'locked' | 'pending' | 'neutral';
}

const VIEW_ONLY_NOTE = 'View only · no control or audio';

function clientToUiPhase(inputs: ScreenUiInputs): ScreenUiPhase {
  if (!inputs.screenViewGranted) return 'no-cap';
  if (!inputs.online) {
    // offline overrides an idle/requesting client, but a terminal deny/expiry stays truthful
    const p = inputs.client.phase;
    if (p === 'permission-denied' || p === 'revoked' || p === 'expired') return p;
    return 'offline';
  }
  const p: ScreenClientPhase = inputs.client.phase;
  switch (p) {
    case 'live': return inputs.client.latestFrame ? 'live' : 'requesting';
    case 'requesting': return 'requesting';
    case 'permission-required': return 'permission-required';
    case 'permission-denied': return 'permission-denied';
    case 'busy': return 'busy';
    case 'source-lost': return 'source-lost';
    case 'source-required': return 'source-required';
    case 'revoked': return 'revoked';
    case 'expired': return 'expired';
    case 'error': return 'error';
    case 'offline': return 'offline';
    case 'idle':
    case 'stopped':
    default: return 'idle';
  }
}

export function deriveScreenViewModel(inputs: ScreenUiInputs): ScreenViewModel {
  const phase = clientToUiPhase(inputs);
  const source = inputs.client.sourceLabel ?? inputs.configuredSourceLabel;
  const base = {
    viewOnlyNote: VIEW_ONLY_NOTE,
    sourceLabel: source,
    frameAccessibilityLabel: `Live view of ${source ?? 'the screen'} on ${inputs.hostName}`,
    showFrame: false,
    showViewButton: false,
    showStopButton: false,
  };
  switch (phase) {
    case 'no-cap':
      return { ...base, phase, title: 'Screen viewing not enabled', subtitle: `This device wasn't granted screen access for ${inputs.hostName}. Re-enroll and choose “View Mac screen” to enable it.`, statusTone: 'locked' };
    case 'offline':
      return { ...base, phase, title: 'Mac is offline', subtitle: `${inputs.hostName} isn't reachable right now. The screen will be viewable when it's back online.`, statusTone: 'offline' };
    case 'idle': {
      // B1-R1: until a live client is attached, don't offer a View button that would
      // no-op — show a truthful "Preparing…" state (the runtime attaches within a tick).
      const attached = inputs.attached !== false;
      if (!attached) {
        return { ...base, phase, title: 'Screen', subtitle: 'Preparing a secure connection to the Mac…', showViewButton: false, statusTone: 'pending' };
      }
      return { ...base, phase, title: 'Screen', subtitle: source ? `Ready to view ${source}.` : 'Ready to view the configured display.', showViewButton: true, statusTone: 'neutral' };
    }
    case 'requesting':
      return { ...base, phase, title: 'Starting live view…', subtitle: 'Waiting for the Mac to accept and send the first frame.', showStopButton: true, statusTone: 'pending' };
    case 'live':
      return { ...base, phase, title: 'Live', subtitle: source ?? inputs.hostName, showFrame: true, showStopButton: true, statusTone: 'online' };
    case 'permission-required':
      return { ...base, phase, title: 'Screen Recording permission needed', subtitle: `${inputs.hostName} needs macOS Screen Recording permission. Approve it in System Settings on the Mac, then try again.`, showViewButton: true, statusTone: 'locked' };
    case 'permission-denied':
      return { ...base, phase, title: 'Screen Recording denied', subtitle: `${inputs.hostName} denied Screen Recording. Enable it in System Settings → Privacy & Security → Screen Recording.`, statusTone: 'locked' };
    case 'busy':
      return { ...base, phase, title: 'Another device is viewing', subtitle: 'Only one viewer at a time. Try again once the other device stops.', showViewButton: true, statusTone: 'pending' };
    case 'source-lost':
      return { ...base, phase, title: 'Display unavailable', subtitle: 'The configured display is no longer available. Viewing stopped.', showViewButton: true, statusTone: 'locked' };
    case 'source-required':
      return { ...base, phase, title: 'No display chosen yet', subtitle: `${inputs.hostName} hasn't picked a display to share. Choose one on the Mac (Controllers → Screen sharing), then try again.`, showViewButton: true, statusTone: 'locked' };
    case 'revoked':
      return { ...base, phase, title: 'Access revoked', subtitle: 'Screen access for this device was revoked on the Mac.', statusTone: 'locked' };
    case 'expired':
      return { ...base, phase, title: 'Session expired', subtitle: 'The viewing session expired. Start a new one when you’re ready.', showViewButton: true, statusTone: 'locked' };
    case 'error':
    default:
      return { ...base, phase, title: 'Couldn’t view the screen', subtitle: 'Something interrupted the stream. You can try again.', showViewButton: true, statusTone: 'locked' };
  }
}
