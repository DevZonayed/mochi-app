/**
 * ShadowGate — Phase 3C2 enrollment gate. Renders the truthful non-content phases of
 * the real controller state machine (loading / unenrolled / confirming / requesting /
 * pending / approving / denied / expired / revoked / repair). Every fact shown is an
 * authoritative, safe field from `ShadowUiState.enrollment` — short ids + host
 * fingerprint + the account.read capability label. No fake progress, no raw secrets.
 * Local component state controls ONLY the scanner overlay — never authority.
 */
import React from 'react';
import { View, Text, ScrollView, Pressable } from 'react-native';
import { useTheme } from '../../theme';
import { Icon, type IconName } from '../../Icon';
import type { ShadowUiState } from '../../shadowUiModel';
import type { ShadowUiController } from '../../shadowUiController';
import type { AccountEnrollmentMac } from '../../shadowEnrollmentClient';
import { deactivateControllerMode } from '../../controllerMode';
import { ACTION_FAMILIES, requestedCapabilitiesFor, type ActionFamilyKey } from '../../shadowActionCapabilities';
import { Screen, ScreenHeader, Busy, PrimaryButton, GhostButton, EmptyState, useInsets } from './parts';
import { ShadowScanner } from './ShadowScanner';

function Centered({ children }: { children: React.ReactNode }) {
  const insets = useInsets();
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24, paddingHorizontal: 20 }}>
        {children}
      </ScrollView>
    </Screen>
  );
}

function IconBadge({ name, tone }: { name: IconName; tone: string }) {
  return (
    <View style={{ width: 72, height: 72, borderRadius: 22, backgroundColor: tone + '1c', alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginBottom: 18 }}>
      <Icon name={name} size={32} color={tone} />
    </View>
  );
}

/** A selectable "View only" / "Control actions" card (radio semantics). */
function ModeCard({ active, onPress, icon, title, subtitle }: { active: boolean; onPress: () => void; icon: IconName; title: string; subtitle: string }) {
  const { theme } = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="radio" accessibilityState={{ selected: active }} accessibilityLabel={`${title}. ${subtitle}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14, borderWidth: 1.5, borderColor: active ? theme.color.blue : theme.color.separator, backgroundColor: active ? theme.color.blue + '12' : theme.color.bgElevated }}>
      <View style={{ width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: (active ? theme.color.blue : theme.color.inkTertiary) + '22' }}>
        <Icon name={icon} size={18} color={active ? theme.color.blue : theme.color.inkSecondary} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontSize: 16, fontWeight: '700', color: theme.color.ink }}>{title}</Text>
        <Text style={{ fontSize: 13, color: theme.color.inkSecondary, marginTop: 1 }}>{subtitle}</Text>
      </View>
      <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 1.6, borderColor: active ? theme.color.blue : theme.color.inkTertiary, alignItems: 'center', justifyContent: 'center' }}>
        {active ? <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: theme.color.blue }} /> : null}
      </View>
    </Pressable>
  );
}

function MacRow({ mac, busy, onPress }: { mac: AccountEnrollmentMac; busy: boolean; onPress: () => void }) {
  const { theme } = useTheme();
  return (
    <Pressable disabled={!mac.online || busy} onPress={onPress} accessibilityRole="button" accessibilityState={{ disabled: !mac.online || busy }}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14, borderWidth: 0.5, borderColor: theme.color.separator, backgroundColor: theme.color.bgElevated, opacity: mac.online ? 1 : 0.55 }}>
      <View style={{ width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: (mac.online ? theme.color.green : theme.color.inkTertiary) + '22' }}>
        <Icon name="monitor" size={18} color={mac.online ? theme.color.green : theme.color.inkSecondary} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '700', color: theme.color.ink }}>{mac.name || mac.hostDeviceId}</Text>
        <Text numberOfLines={1} style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 1 }}>{mac.online ? 'Online' : 'Offline'} · {mac.fingerprint.slice(0, 12)}</Text>
      </View>
      <Icon name="chevronRight" size={18} color={theme.color.inkTertiary} />
    </Pressable>
  );
}

export function ShadowGate({ state, controller }: { state: ShadowUiState; controller: ShadowUiController }) {
  const { theme } = useTheme();
  const [scanning, setScanning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [macs, setMacs] = React.useState<AccountEnrollmentMac[]>([]);
  const [loadingMacs, setLoadingMacs] = React.useState(false);
  // Least-privilege enrollment choice (Section A): default View only; Control actions is an
  // EXPLICIT opt-in with per-family selection (nothing pre-selected). account.read is always
  // requested (the read floor). The chosen set is applied to the runtime BEFORE the scan.
  const [mode, setMode] = React.useState<'view' | 'control'>('view');
  const [selected, setSelected] = React.useState<Set<ActionFamilyKey>>(() => new Set());
  // Screen access is a SEPARATE, unchecked opt-in (Section A.1) — orthogonal to the
  // view/control action mode. Nothing about it is pre-selected.
  const [screenView, setScreenView] = React.useState(false);
  const phase = state.phase;

  const beginScan = React.useCallback(() => {
    void controller.setRequestedCapabilities(requestedCapabilitiesFor(mode, [...selected], screenView));
    setError(null); setScanning(true);
  }, [controller, mode, selected, screenView]);
  const loadMacs = React.useCallback(async () => {
    setLoadingMacs(true);
    const res = await controller.listAccountMacs();
    setLoadingMacs(false);
    if (res.ok) { setMacs(res.macs); setError(null); }
    else setError(res.reason);
  }, [controller]);
  React.useEffect(() => { if (phase === 'unenrolled') void loadMacs(); }, [phase, loadMacs]);
  const beginAccountMac = React.useCallback(async (hostDeviceId: string) => {
    void controller.setRequestedCapabilities(requestedCapabilitiesFor(mode, [...selected], screenView));
    setError(null);
    const res = await controller.beginAccountEnrollment(hostDeviceId);
    if (!res.ok) setError(res.reason ?? 'Request failed');
  }, [controller, mode, selected, screenView]);
  const confirmEnrollment = React.useCallback(async () => {
    setError(null);
    const res = await controller.confirmEnrollment();
    if (!res.ok) setError(state.enrollment.errorReason ?? 'Something went wrong. Please try again.');
  }, [controller, state.enrollment.errorReason]);
  const toggle = (k: ActionFamilyKey) => setSelected((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  // Close the scanner once the runtime leaves the unenrolled phase (parse succeeded).
  React.useEffect(() => { if (phase !== 'unenrolled') setScanning(false); }, [phase]);

  if (scanning && phase === 'unenrolled') {
    return (
      <ShadowScanner
        busy={state.busy}
        onCancel={() => { setScanning(false); setError(null); }}
        onScanned={async (raw) => {
          const res = await controller.beginEnrollment(raw);
          if (!res.ok) setError('That code didn’t work. Ask your Mac for a fresh one.');
        }}
      />
    );
  }

  switch (phase) {
    case 'loading':
      return <Busy label="Loading…" />;
    case 'requesting':
      return <Busy label="Sending the request to your Mac…" />;
    case 'approving':
      return <Busy label="Setting up a secure connection…" />;

    case 'unenrolled':
      return (
        <Screen>
          <ScrollView contentContainerStyle={{ flexGrow: 1, paddingTop: 40, paddingBottom: 32, paddingHorizontal: 20 }} keyboardShouldPersistTaps="handled">
            <IconBadge name="smartphone" tone={theme.color.blue} />
            <Text accessibilityRole="header" style={{ fontSize: 24, fontWeight: '700', color: theme.color.ink, textAlign: 'center', marginBottom: 10 }}>Control your Mac from here</Text>
            <Text style={{ fontSize: 15, lineHeight: 21, color: theme.color.inkSecondary, textAlign: 'center', marginBottom: 20 }}>
              Choose what this device may do, then select a Mac from your account. You’ll approve it on the Mac.
            </Text>

            {/* Least-privilege choice: View only (default) vs Control actions (explicit). */}
            <ModeCard active={mode === 'view'} onPress={() => setMode('view')} icon="shield" title="View only" subtitle="Read your projects & activity. Safest — no changes." />
            <View style={{ height: 10 }} />
            <ModeCard active={mode === 'control'} onPress={() => setMode('control')} icon="bolt" title="Control actions" subtitle="Read access plus the specific actions you choose below." />

            {mode === 'control' ? (
              <View style={{ marginTop: 12, backgroundColor: theme.color.bgElevated, borderRadius: 14, borderWidth: 0.5, borderColor: theme.color.separator, overflow: 'hidden' }}>
                {ACTION_FAMILIES.map((f, i) => {
                  const on = selected.has(f.key);
                  return (
                    <Pressable key={f.key} onPress={() => toggle(f.key)} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={`${f.label}. ${f.description}`}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 14, borderBottomWidth: i === ACTION_FAMILIES.length - 1 ? 0 : 0.5, borderBottomColor: theme.color.separator }}>
                      <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 1.6, borderColor: on ? theme.color.blue : theme.color.inkTertiary, backgroundColor: on ? theme.color.blue : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                        {on ? <Icon name="check" size={14} color="#fff" stroke={2.6} /> : null}
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ fontSize: 15, fontWeight: '600', color: theme.color.ink }}>{f.label}</Text>
                        <Text style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 1 }}>{f.description}</Text>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}

            {/* Screen access — a SEPARATE group, unchecked by default. View only. */}
            <Text style={{ fontSize: 12, fontWeight: '700', color: theme.color.inkSecondary, marginTop: 18, marginBottom: 6, marginLeft: 2, textTransform: 'uppercase', letterSpacing: 0.4 }}>Screen access</Text>
            <View style={{ backgroundColor: theme.color.bgElevated, borderRadius: 14, borderWidth: 0.5, borderColor: theme.color.separator, overflow: 'hidden' }}>
              <Pressable onPress={() => setScreenView((v) => !v)} accessibilityRole="checkbox" accessibilityState={{ checked: screenView }} accessibilityLabel="View Mac screen. View only, no control or audio."
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 14 }}>
                <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 1.6, borderColor: screenView ? theme.color.blue : theme.color.inkTertiary, backgroundColor: screenView ? theme.color.blue : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                  {screenView ? <Icon name="check" size={14} color="#fff" stroke={2.6} /> : null}
                </View>
                <View style={{ width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.inkTertiary + '22' }}>
                  <Icon name="monitor" size={16} color={theme.color.inkSecondary} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ fontSize: 15, fontWeight: '600', color: theme.color.ink }}>View Mac screen</Text>
                  <Text style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 1 }}>View only · no control or audio</Text>
                </View>
              </Pressable>
            </View>

            <Text style={{ fontSize: 12, color: theme.color.inkTertiary, textAlign: 'center', marginTop: 14, marginBottom: 16 }}>
              Read access is always included. You can revoke this device from your Mac at any time.
            </Text>
            <Text style={{ fontSize: 12, fontWeight: '700', color: theme.color.inkSecondary, marginBottom: 8, marginLeft: 2, textTransform: 'uppercase', letterSpacing: 0.4 }}>Your Macs</Text>
            <View style={{ gap: 10, marginBottom: 14 }}>
              {loadingMacs ? <Busy label="Finding Macs…" /> : macs.length ? macs.map((m) => <MacRow key={m.hostDeviceId} mac={m} busy={state.busy} onPress={() => void beginAccountMac(m.hostDeviceId)} />) : (
                <Text style={{ fontSize: 13, color: theme.color.inkTertiary, textAlign: 'center' }}>No eligible Mac is online for this account.</Text>
              )}
            </View>
            {error ?? state.enrollment.errorReason ? <Text role="alert" style={{ fontSize: 13, color: theme.color.red, textAlign: 'center', marginBottom: 14 }}>{error ?? state.enrollment.errorReason}</Text> : null}
            <GhostButton title="Use enrollment code instead" onPress={beginScan} />
            <View style={{ height: 10 }} />
            <GhostButton title="Not now" onPress={() => { void deactivateControllerMode(); }} />
          </ScrollView>
        </Screen>
      );

    case 'confirming':
      return (
        <Centered>
          <IconBadge name="shield" tone={theme.color.blue} />
          <Text accessibilityRole="header" style={{ fontSize: 22, fontWeight: '700', color: theme.color.ink, textAlign: 'center', marginBottom: 10 }}>Confirm it’s your Mac</Text>
          <Text style={{ fontSize: 15, lineHeight: 21, color: theme.color.inkSecondary, textAlign: 'center', marginBottom: 18 }}>
            Check that this matches the Mac you’re enrolling, then request access. You’ll approve the request on the Mac.
          </Text>
          <View style={{ backgroundColor: theme.color.bgElevated, borderRadius: 14, borderWidth: 0.5, borderColor: theme.color.separator, padding: 16, marginBottom: 20 }}>
            <LabeledRow label="Mac fingerprint" value={state.enrollment.hostFingerprintShort ?? '—'} mono />
            <View style={{ height: 12 }} />
            <LabeledRow label="This device" value={state.enrollment.controllerDeviceIdShort ?? '—'} mono />
            <View style={{ height: 12 }} />
            <LabeledRow label="Requesting" value={state.enrollment.requestedCapabilityLabels.join(', ')} />
          </View>
          {error ? <Text role="alert" style={{ fontSize: 13, color: theme.color.red, textAlign: 'center', marginBottom: 14 }}>{error}</Text> : null}
          <PrimaryButton title="Request access" icon="arrowRight" onPress={() => void confirmEnrollment()} />
          <View style={{ height: 10 }} />
          <GhostButton title="Cancel" onPress={() => void controller.cancelEnrollment()} />
        </Centered>
      );

    case 'pending':
      return (
        <Centered>
          <IconBadge name="clock" tone={theme.color.orange} />
          <Text accessibilityRole="header" style={{ fontSize: 22, fontWeight: '700', color: theme.color.ink, textAlign: 'center', marginBottom: 10 }}>Waiting for your Mac</Text>
          <Text style={{ fontSize: 15, lineHeight: 21, color: theme.color.inkSecondary, textAlign: 'center', marginBottom: 8 }}>
            Open Settings → Controllers on your Mac and approve this device. This screen updates the moment it’s approved.
          </Text>
          <Text style={{ fontSize: 13, color: theme.color.inkTertiary, textAlign: 'center', marginBottom: 24, fontFamily: theme.fontFamily.mono }}>
            {state.enrollment.controllerDeviceIdShort ?? ''}
          </Text>
          <GhostButton title="Cancel request" onPress={() => void controller.cancelEnrollment()} />
        </Centered>
      );

    case 'denied':
    case 'expired':
      return (
        <Centered>
          <IconBadge name="xCircle" tone={theme.color.inkTertiary} />
          <Text accessibilityRole="header" style={{ fontSize: 22, fontWeight: '700', color: theme.color.ink, textAlign: 'center', marginBottom: 10 }}>
            {phase === 'denied' ? 'Request declined' : 'Request expired'}
          </Text>
          <Text style={{ fontSize: 15, lineHeight: 21, color: theme.color.inkSecondary, textAlign: 'center', marginBottom: 24 }}>
            {state.enrollment.errorReason ?? 'Please try again.'}
          </Text>
          <PrimaryButton title="Try again" icon="refresh" onPress={() => void controller.retryEnrollment()} />
        </Centered>
      );

    case 'revoked':
    case 'repair':
      return (
        <Centered>
          <IconBadge name="lock" tone={theme.color.red} />
          <Text accessibilityRole="header" style={{ fontSize: 22, fontWeight: '700', color: theme.color.ink, textAlign: 'center', marginBottom: 10 }}>Access ended</Text>
          <Text style={{ fontSize: 15, lineHeight: 21, color: theme.color.inkSecondary, textAlign: 'center', marginBottom: 24 }}>
            {state.enrollment.errorReason ?? 'This device is no longer connected to your Mac.'} You can enroll again to reconnect.
          </Text>
          <PrimaryButton title="Reconnect" icon="smartphone" onPress={() => void controller.retryEnrollment()} />
        </Centered>
      );

    default:
      return <EmptyState icon="shield" title="Not connected" />;
  }
}

function LabeledRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const { theme } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <Text style={{ fontSize: 13, color: theme.color.inkTertiary }}>{label}</Text>
      <Text numberOfLines={1} style={{ flex: 1, textAlign: 'right', fontSize: 14, fontWeight: '600', color: theme.color.ink, fontFamily: mono ? theme.fontFamily.mono : undefined }}>{value}</Text>
    </View>
  );
}
