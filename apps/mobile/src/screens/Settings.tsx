import React, { useState } from 'react';
import { View, Text, Pressable, ScrollView, Animated, StyleSheet, Modal, TextInput, Alert, Linking, Platform, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import Constants from 'expo-constants';
import { useTheme } from '../theme';
import type { ThemeMode } from '@maestro/design-tokens';
import { Icon } from '../Icon';
import { Group, Row } from '../ui';
import { api, getPairToken, setPairToken, API_BASE, type Workspace, type Effort as ApiEffort, type EngineId } from '../api';
import { setFlag, ONBOARDED, getFlag, BIOMETRIC_GATE, USE_WS_STREAM, clearCache } from '../storage';
import { unregisterPush, getPushState, subscribePush, registerForPush, refreshPushStatus, type PushState } from '../push';
import { NOTIF_CATEGORIES, getNotifPrefs, setNotifPref } from '../notifPrefs';
import { biometricAvailable, confirmBiometric } from '../biometrics';

/* iOS-style toggle switch — animated thumb. */
function MSwitch({ value, disabled, onValueChange }: { value: boolean; disabled?: boolean; onValueChange?: (v: boolean) => void }) {
  const { theme } = useTheme();
  const a = React.useRef(new Animated.Value(value ? 1 : 0)).current;
  React.useEffect(() => {
    Animated.timing(a, { toValue: value ? 1 : 0, duration: 220, useNativeDriver: false }).start();
  }, [a, value]);
  const bg = a.interpolate({ inputRange: [0, 1], outputRange: [theme.color.fillSecondary, theme.color.green] });
  const left = a.interpolate({ inputRange: [0, 1], outputRange: [2, 22] });
  return (
    <Pressable onPress={() => !disabled && onValueChange?.(!value)} hitSlop={6} style={{ opacity: disabled ? 0.4 : 1 }}>
      <Animated.View style={{ width: 51, height: 31, borderRadius: 16, backgroundColor: bg, justifyContent: 'center' }}>
        <Animated.View
          style={{
            position: 'absolute',
            top: 2,
            left,
            width: 27,
            height: 27,
            borderRadius: 14,
            backgroundColor: '#fff',
            shadowColor: '#000',
            shadowOpacity: 0.25,
            shadowRadius: 2.5,
            shadowOffset: { width: 0, height: 2 },
            elevation: 2,
          }}
        />
      </Animated.View>
    </Pressable>
  );
}

const EFFORT_STOPS = ['FAST', 'BALANCED', 'DEEP', 'MAX'] as const;
type Effort = (typeof EFFORT_STOPS)[number];
const toApiEffort = (e: Effort): ApiEffort => e.toLowerCase() as ApiEffort;
const fromApiEffort = (e: ApiEffort): Effort => e.toUpperCase() as Effort;

function useEffortMeta() {
  const { theme } = useTheme();
  return {
    FAST: { tint: theme.color.green, bars: 1 },
    BALANCED: { tint: theme.color.blue, bars: 2 },
    DEEP: { tint: theme.color.orange, bars: 3 },
    MAX: { tint: theme.color.red, bars: 4 },
  } satisfies Record<Effort, { tint: string; bars: number }>;
}

/* 4 ascending bars; filled up to `level`. */
function StrengthBars({ level, tint, size = 13 }: { level: number; tint: string; size?: number }) {
  const { theme } = useTheme();
  const heights = [0.42, 0.62, 0.82, 1];
  const bw = size * 0.17;
  const gap = size * 0.115;
  return (
    <View style={{ width: size, height: size, flexDirection: 'row', alignItems: 'flex-end', gap }}>
      {heights.map((h, idx) => {
        const on = idx < level;
        return (
          <View
            key={idx}
            style={{
              width: bw,
              height: size * h,
              borderRadius: bw * 0.4,
              backgroundColor: on ? tint : theme.color.inkTertiary,
              opacity: on ? 1 : 0.3,
            }}
          />
        );
      })}
    </View>
  );
}

function EffortDial({ value, onChange }: { value: Effort; onChange: (v: Effort) => void }) {
  const { theme } = useTheme();
  const meta = useEffortMeta()[value];
  const cycle = () => {
    const i = EFFORT_STOPS.indexOf(value);
    onChange(EFFORT_STOPS[(i + 1) % 4]);
  };
  return (
    <Pressable
      onPress={cycle}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        height: 28,
        paddingHorizontal: 11,
        borderRadius: theme.radius.pill,
        backgroundColor: meta.tint + '1C',
        borderWidth: 1,
        borderColor: meta.tint + '52',
      }}
    >
      <StrengthBars level={meta.bars} tint={meta.tint} size={13} />
      <Text style={{ fontSize: 11, fontWeight: '700', letterSpacing: 0.55, color: meta.tint }}>{value}</Text>
      <View style={{ flexDirection: 'row', gap: 2, marginLeft: 1 }}>
        {[0, 1, 2, 3].map((d) => {
          const active = d === EFFORT_STOPS.indexOf(value);
          return (
            <View
              key={d}
              style={{ width: 3, height: 3, borderRadius: 2, backgroundColor: active ? meta.tint : theme.color.inkTertiary, opacity: active ? 1 : 0.35 }}
            />
          );
        })}
      </View>
    </Pressable>
  );
}

/* Engine picker — the real AppSettings.defaultEngine (auto / Claude / Codex). */
type EngineChoice = EngineId | 'auto';
const ENGINES: { id: EngineChoice; name: string; sub: string }[] = [
  { id: 'auto', name: 'Auto', sub: 'Routed per task' },
  { id: 'claude', name: 'Claude Code', sub: 'Your Claude login' },
  { id: 'codex', name: 'Codex', sub: 'Your ChatGPT login' },
];

function EngineSwitcher({ value, onChange }: { value: EngineChoice; onChange: (id: EngineChoice) => void }) {
  const { theme } = useTheme();
  const [open, setOpen] = useState(false);
  const cur = ENGINES.find((m) => m.id === value) ?? ENGINES[0];
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 7, height: 28, paddingHorizontal: 10, borderRadius: 9, backgroundColor: theme.color.fillSecondary }}
      >
        <Icon name="spark" size={15} color={cur.id === 'auto' ? theme.color.inkSecondary : theme.color.ink} />
        <Text style={{ fontSize: 13, fontWeight: '600', color: theme.color.ink }}>{cur.name}</Text>
        <Icon name="chevronDown" size={13} color={theme.color.inkTertiary} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(10,12,24,0.4)', justifyContent: 'center', alignItems: 'center' }} onPress={() => setOpen(false)}>
          <Pressable
            onPress={() => {}}
            style={{
              width: 256,
              backgroundColor: theme.color.bgElevated,
              borderRadius: 12,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: theme.color.separator,
              padding: 4,
              shadowColor: '#0f1432',
              shadowOpacity: 0.22,
              shadowRadius: 50,
              shadowOffset: { width: 0, height: 18 },
              elevation: 12,
            }}
          >
            {ENGINES.map((m) => {
              const on = m.id === value;
              return (
                <Pressable
                  key={m.id}
                  onPress={() => { onChange(m.id); setOpen(false); }}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 9, borderRadius: 8, backgroundColor: on ? theme.color.blue + '1A' : 'transparent' }}
                >
                  <View style={{ width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.fillTertiary }}>
                    <Icon name="spark" size={17} color={m.id === 'auto' ? theme.color.inkSecondary : theme.color.ink} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ fontSize: 15, fontWeight: '600', color: theme.color.ink }}>{m.name}</Text>
                    <Text style={{ fontSize: 11, color: theme.color.inkTertiary, marginTop: 2 }}>{m.sub}</Text>
                  </View>
                  {on ? <Icon name="check" size={16} color={theme.color.blue} stroke={2.6} /> : null}
                </Pressable>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

/* Send-feedback bottom sheet — submits to the Mac (source: 'phone'). */
function FeedbackSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { theme } = useTheme();
  const [category, setCategory] = useState<'bug' | 'idea' | 'other'>('idea');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const cats: { id: 'bug' | 'idea' | 'other'; label: string }[] = [
    { id: 'bug', label: 'Bug' }, { id: 'idea', label: 'Idea' }, { id: 'other', label: 'Other' },
  ];
  const close = () => { setMessage(''); setCategory('idea'); setBusy(false); setDone(false); setError(''); onClose(); };
  const submit = () => {
    const text = message.trim();
    if (!text || busy) return;
    setBusy(true); setError('');
    api.submitFeedback({ category, message: text })
      .then(() => { setDone(true); setTimeout(close, 1100); })
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : 'Could not send.'); setBusy(false); });
  };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(10,12,24,0.4)', justifyContent: 'flex-end' }} onPress={close}>
        <Pressable onPress={() => {}} style={{ backgroundColor: theme.color.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, paddingBottom: 36 }}>
          {done ? (
            <View style={{ alignItems: 'center', paddingVertical: 22 }}>
              <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: theme.color.green + '28', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
                <Icon name="check" size={26} color={theme.color.green} stroke={2.6} />
              </View>
              <Text style={{ fontSize: 18, fontWeight: '700', color: theme.color.ink }}>Thanks for the feedback</Text>
              <Text style={{ fontSize: 14, color: theme.color.inkSecondary, marginTop: 4 }}>Saved on your Mac.</Text>
            </View>
          ) : (
            <>
              <Text style={{ fontSize: 20, fontWeight: '700', color: theme.color.ink, marginBottom: 4 }}>Send feedback</Text>
              <Text style={{ fontSize: 14, color: theme.color.inkSecondary, marginBottom: 16 }}>Found a bug or have an idea? We read every note.</Text>
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                {cats.map((c) => {
                  const on = category === c.id;
                  return (
                    <Pressable key={c.id} onPress={() => setCategory(c.id)} style={{ flex: 1, height: 40, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: on ? theme.color.blue : theme.color.separator, backgroundColor: on ? theme.color.blue + '18' : theme.color.fillTertiary }}>
                      <Text style={{ fontSize: 14, fontWeight: on ? '700' : '500', color: on ? theme.color.blue : theme.color.inkSecondary }}>{c.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
              <TextInput
                value={message}
                onChangeText={setMessage}
                multiline
                placeholder={category === 'bug' ? 'What went wrong?' : category === 'idea' ? 'What would make Maestro better?' : 'Tell us what’s on your mind…'}
                placeholderTextColor={theme.color.inkTertiary}
                style={{ minHeight: 110, borderRadius: 12, borderWidth: 1, borderColor: theme.color.separator, backgroundColor: theme.color.fillTertiary, padding: 12, fontSize: 16, color: theme.color.ink, textAlignVertical: 'top' }}
              />
              {error ? <Text style={{ fontSize: 13, color: theme.color.red, marginTop: 10 }}>{error}</Text> : null}
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
                <Pressable onPress={close} style={{ flex: 1, height: 48, borderRadius: theme.radius.pill, backgroundColor: theme.color.fillSecondary, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ fontSize: 16, fontWeight: '600', color: theme.color.ink }}>Cancel</Text>
                </Pressable>
                <Pressable onPress={submit} disabled={!message.trim() || busy} style={{ flex: 1, height: 48, borderRadius: theme.radius.pill, backgroundColor: !message.trim() || busy ? theme.color.fillSecondary : theme.color.blue, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ fontSize: 16, fontWeight: '600', color: !message.trim() || busy ? theme.color.inkTertiary : '#fff' }}>{busy ? 'Sending…' : 'Send'}</Text>
                </Pressable>
              </View>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const relayHost = API_BASE.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
const appVersion = Constants.expoConfig?.version ?? '—';

/* Live PushState hook — re-renders Settings whenever registerForPush/
   refreshPushStatus updates the cached state. */
function usePushState(): PushState {
  const [s, setS] = useState<PushState>(getPushState());
  React.useEffect(() => subscribePush(setS), []);
  return s;
}

/* Human-readable summary for the Settings row — answers "is closed-app push
   actually going to work?" in one line. */
function pushSummary(s: PushState): { label: string; tint: 'green' | 'red' | 'orange' | 'inkSecondary'; hint: string } {
  if (!s.projectId) {
    return { label: 'Not configured', tint: 'red', hint: 'Build the app with EAS to enable closed-app pushes.' };
  }
  if (s.permission === 'denied') {
    return { label: 'Permission denied', tint: 'red', hint: 'Allow notifications in iOS/Android Settings to receive closed-app alerts.' };
  }
  if (s.permission === 'undetermined' || s.permission === 'unknown') {
    return { label: 'Not asked yet', tint: 'orange', hint: 'Tap Re-register to ask for permission and register this phone.' };
  }
  if (!s.token) {
    return { label: 'No token', tint: 'orange', hint: s.lastError || 'Tap Re-register to mint a push token.' };
  }
  if (!s.registered) {
    return { label: 'Not on relay', tint: 'orange', hint: s.lastError || 'Token minted but relay didn’t confirm. Tap Re-register.' };
  }
  return { label: 'Enabled', tint: 'green', hint: 'This phone will receive alerts even when the app is closed.' };
}

export function SettingsScreen() {
  const { theme, override, setOverride } = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();

  const [eff, setEff] = useState<Effort>('BALANCED');
  const [engine, setEngine] = useState<EngineChoice>('auto');
  const [notifs, setNotifs] = useState(getNotifPrefs());
  const [bioGate, setBioGate] = useState(getFlag(BIOMETRIC_GATE));
  // USE_WS_STREAM: opt-in to the WebSocket transport for live events. Off by
  // default — SSE still works everywhere; WS is a perf upgrade for chats.
  const [wsStream, setWsStream] = useState(getFlag(USE_WS_STREAM));
  const [bioAvail, setBioAvail] = useState(true);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [conn, setConn] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [outbox, setOutbox] = useState(api.outbox().length);
  const [fbOpen, setFbOpen] = useState(false);
  const push = usePushState();
  const pushInfo = pushSummary(push);
  const [pushBusy, setPushBusy] = useState(false);

  const testConnection = () => {
    setConn('testing');
    api.verifyPairing().then((r) => setConn(r === 'invalid' || r === 'unreachable' ? 'fail' : 'ok')).catch(() => setConn('fail'));
  };

  React.useEffect(() => { void biometricAvailable().then(setBioAvail); }, []);
  React.useEffect(() => api.onOutbox(() => setOutbox(api.outbox().length)), []);

  // Live workspace + persisted defaults whenever the screen regains focus.
  useFocusEffect(
    React.useCallback(() => {
      let alive = true;
      api.listWorkspaces().then((wss) => { if (alive) setWorkspace(wss[0] ?? null); }).catch(() => { if (alive) setWorkspace(null); });
      api.getSettings().then((s) => {
        if (!alive || !s) return;
        setEff(fromApiEffort(s.defaultEffort));
        setEngine(s.defaultEngine);
      }).catch(() => {});
      setOutbox(api.outbox().length);
      // Probe the relay for "does it still have my token?" — surfaces a
      // post-redeploy "Not on relay" without the user needing to re-open the app.
      void refreshPushStatus();
      return () => { alive = false; };
    }, []),
  );

  /* Re-register: re-run the perm prompt + mint a fresh Expo token + register
     with the relay. Idempotent. If perms are denied, deep-link to OS settings. */
  const reRegisterPush = React.useCallback(async () => {
    if (pushBusy) return;
    setPushBusy(true);
    try {
      await registerForPush();
      await refreshPushStatus();
      const s = getPushState();
      if (s.permission === 'denied') {
        Alert.alert(
          'Notifications are off',
          'Allow notifications in your phone’s Settings to receive alerts while the app is closed.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open Settings', onPress: () => { void Linking.openSettings(); } },
          ],
        );
      } else if (!s.projectId) {
        Alert.alert(
          'EAS build required',
          'Closed-app push needs a dev or production EAS build (Expo Go can’t deliver remote pushes). Once you install an EAS build on this phone, this row will turn green.',
        );
      }
    } finally {
      setPushBusy(false);
    }
  }, [pushBusy]);

  const changeEffort = (e: Effort) => { setEff(e); void api.setSettings({ defaultEffort: toApiEffort(e) }).catch(() => {}); };
  const changeEngine = (id: EngineChoice) => { setEngine(id); void api.setSettings({ defaultEngine: id }).catch(() => {}); };

  const toggleBio = async (next: boolean) => {
    if (!next) { setBioGate(false); setFlag(BIOMETRIC_GATE, false); return; }
    if (!bioAvail) { Alert.alert('No biometrics', 'This device has no Face ID / fingerprint enrolled.'); return; }
    const ok = await confirmBiometric('Enable biometric approval');
    if (ok) { setBioGate(true); setFlag(BIOMETRIC_GATE, true); }
  };

  const themeSegs: { label: string; mode: ThemeMode | null }[] = [
    { label: 'Light', mode: 'light' }, { label: 'Dark', mode: 'dark' }, { label: 'Auto', mode: null },
  ];

  const rowLabel: ViewStyle = { flex: 1 };
  const labelText = { fontSize: 16, color: theme.color.ink } as const;

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 6, paddingBottom: 28 }} showsVerticalScrollIndicator={false}>
        <View style={{ paddingHorizontal: 20, paddingBottom: 10 }}>
          <Text style={{ fontSize: 34, fontWeight: '700', letterSpacing: -0.7, color: theme.color.ink }}>Settings</Text>
        </View>

        {/* connection hero */}
        <View style={{ marginHorizontal: 16, marginBottom: 22, padding: 18, borderRadius: 16, backgroundColor: theme.color.bgElevated, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.color.separator }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 13 }}>
            <View style={{ width: 46, height: 46, borderRadius: 13, backgroundColor: theme.color.fillSecondary, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="smartphone" size={24} color={theme.color.inkSecondary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 17, fontWeight: '600', color: theme.color.ink }}>{workspace?.name ?? 'Your Mac'}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 5 }}>
                {conn === 'fail'
                  ? <><View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.color.red }} /><Text style={{ fontSize: 13, fontWeight: '500', color: theme.color.red }}>Can't reach your Mac</Text></>
                  : conn === 'testing'
                    ? <Text style={{ fontSize: 13, fontWeight: '500', color: theme.color.inkSecondary }}>Testing…</Text>
                    : <><View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.color.green }} /><Text style={{ fontSize: 13, fontWeight: '500', color: theme.color.green }}>{conn === 'ok' ? 'Reachable via relay' : 'Paired via relay'}</Text></>}
              </View>
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
            <Pressable onPress={testConnection} style={{ flex: 1, height: 38, borderRadius: theme.radius.pill, backgroundColor: theme.color.fillSecondary, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ fontSize: 14, fontWeight: '600', color: theme.color.ink }}>{conn === 'testing' ? 'Testing…' : 'Test connection'}</Text>
            </Pressable>
          </View>
        </View>

        {/* Pairing */}
        <View style={{ marginBottom: 22 }}>
          <Group header="Pairing" footer="The code from your Mac (Maestro → Settings → Devices). Without it, this phone can't reach your Mac.">
            <Row last>
              <View style={rowLabel}><Text style={labelText}>Code</Text></View>
              <TextInput
                defaultValue={getPairToken()}
                onChangeText={(t: string) => setPairToken(t)}
                autoCapitalize="characters"
                autoCorrect={false}
                placeholder="XXXX-XXXX-XXXX"
                placeholderTextColor={theme.color.inkTertiary}
                style={{ flex: 1, textAlign: 'right', fontSize: 15, fontWeight: '600', letterSpacing: 1, color: theme.color.ink, paddingVertical: 6 }}
              />
            </Row>
          </Group>
        </View>

        {/* Defaults */}
        <View style={{ marginBottom: 22 }}>
          <Group header="Defaults" footer="Applies to new jobs you start from this phone; projects can override.">
            <Row>
              <View style={rowLabel}><Text style={labelText}>Effort</Text></View>
              <EffortDial value={eff} onChange={changeEffort} />
            </Row>
            <Row last>
              <View style={rowLabel}><Text style={labelText}>Engine</Text></View>
              <EngineSwitcher value={engine} onChange={changeEngine} />
            </Row>
          </Group>
        </View>

        {/* Notifications — toggles filter the Activity feed */}
        <View style={{ marginBottom: 22 }}>
          <Group header="Activity feed" footer="Choose which events show in Activity. Destructive approvals always confirm in-app.">
            {NOTIF_CATEGORIES.map((c, i) => (
              <Row key={c.key} last={i === NOTIF_CATEGORIES.length - 1}>
                <View style={rowLabel}><Text style={labelText}>{c.label}</Text></View>
                <MSwitch value={notifs[c.key]} onValueChange={(v) => setNotifs(setNotifPref(c.key, v))} />
              </Row>
            ))}
          </Group>
        </View>

        {/* Push notifications — closed-app alerts via the relay → Expo */}
        <View style={{ marginBottom: 22 }}>
          <Group
            header="Push notifications"
            footer={pushInfo.hint}
          >
            <Row>
              <View style={rowLabel}><Text style={labelText}>Status</Text></View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.color[pushInfo.tint] }} />
                <Text style={{ fontSize: 14, fontWeight: '600', color: theme.color[pushInfo.tint] }}>{pushInfo.label}</Text>
              </View>
            </Row>
            <Row>
              <View style={rowLabel}><Text style={labelText}>EAS project</Text></View>
              <Text style={{ fontSize: 13, fontWeight: '500', fontFamily: theme.fontFamily.mono, color: theme.color.inkTertiary }}>
                {push.projectId ? push.projectId.slice(0, 8) + '…' : 'missing'}
              </Text>
            </Row>
            <Row>
              <View style={rowLabel}><Text style={labelText}>Permission</Text></View>
              <Text style={{ fontSize: 14, fontWeight: '500', color: theme.color.inkSecondary }}>
                {push.permission === 'granted' ? 'Granted' : push.permission === 'denied' ? 'Denied' : push.permission === 'undetermined' ? 'Not asked' : '—'}
              </Text>
            </Row>
            <Row last onPress={reRegisterPush}>
              <View style={{ width: 30, height: 30, borderRadius: 8, backgroundColor: theme.color.blue + '24', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="bell" size={16} color={theme.color.blue} />
              </View>
              <View style={rowLabel}>
                <Text style={{ fontSize: 16, color: theme.color.blue }}>
                  {pushBusy ? 'Registering…' : push.permission === 'denied' ? 'Open OS settings' : 'Re-register this phone'}
                </Text>
              </View>
              <Icon name="chevronRight" size={16} color={theme.color.inkTertiary} />
            </Row>
          </Group>
        </View>

        {/* Connection — transport for the live event stream */}
        <View style={{ marginBottom: 22 }}>
          <Group
            header="Connection"
            footer="WebSocket lowers latency for streaming chat output. SSE (off) is the safe default and works everywhere; turn this on if chats feel laggy."
          >
            <Row last>
              <View style={rowLabel}>
                <Text style={labelText}>Use WebSocket stream</Text>
                <Text style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 2 }}>
                  {wsStream ? 'WS' : 'SSE'} · takes effect on next screen open
                </Text>
              </View>
              <MSwitch value={wsStream} onValueChange={(v) => { setWsStream(v); setFlag(USE_WS_STREAM, v); }} />
            </Row>
          </Group>
        </View>

        {/* Approvals security */}
        <View style={{ marginBottom: 22 }}>
          <Group header="Approvals security" footer={bioAvail ? 'Require Face ID / fingerprint before an approval goes through.' : 'No biometrics enrolled on this device.'}>
            <Row last>
              <View style={rowLabel}>
                <Text style={{ fontSize: 16, lineHeight: 19, color: theme.color.ink }}>Biometric approval</Text>
              </View>
              <MSwitch value={bioGate} disabled={!bioAvail} onValueChange={(v) => { void toggleBio(v); }} />
            </Row>
          </Group>
        </View>

        {/* Appearance */}
        <View style={{ marginBottom: 22 }}>
          <Group header="Appearance">
            <Row last>
              <View style={rowLabel}><Text style={labelText}>Theme</Text></View>
              <View style={{ flexDirection: 'row', gap: 3, padding: 2, backgroundColor: theme.color.fillSecondary, borderRadius: 8 }}>
                {themeSegs.map((o) => {
                  const on = override === o.mode;
                  return (
                    <Pressable
                      key={o.label}
                      onPress={() => setOverride(o.mode)}
                      style={{
                        paddingVertical: 5,
                        paddingHorizontal: 11,
                        borderRadius: 6,
                        backgroundColor: on ? theme.color.bgElevated : 'transparent',
                        ...(on ? { shadowColor: '#000', shadowOpacity: 0.14, shadowRadius: 2, shadowOffset: { width: 0, height: 1 }, elevation: 1 } : {}),
                      }}
                    >
                      <Text style={{ fontSize: 13, fontWeight: '600', color: on ? theme.color.ink : theme.color.inkSecondary }}>{o.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </Row>
          </Group>
        </View>

        {/* Offline & sync */}
        <View style={{ marginBottom: 22 }}>
          <Group header="Offline & sync">
            <Row last onPress={() => nav.navigate('Outbox')}>
              <View style={{ width: 30, height: 30, borderRadius: 8, backgroundColor: 'rgba(255,149,0,0.14)', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="clock" size={16} color={theme.color.orange} />
              </View>
              <View style={rowLabel}><Text style={labelText}>Outbox</Text></View>
              <Text style={{ fontSize: 14, fontWeight: '500', color: theme.color.inkTertiary }}>{outbox === 0 ? 'Empty' : `${outbox} logged`}</Text>
              <Icon name="chevronRight" size={16} color={theme.color.inkTertiary} />
            </Row>
          </Group>
        </View>

        {/* This device */}
        <View style={{ marginBottom: 22 }}>
          <Group header="This device" footer="Unpairing clears the code on this phone; pair again from your Mac's code to reconnect.">
            <Row last onPress={() => {
              void unregisterPush(); // drop this phone's push token from the relay (before the token clears)
              setPairToken('');
              setFlag(ONBOARDED, false);
              void clearCache(); // logout wipes cached projects/chats
              nav.reset({ index: 0, routes: [{ name: 'Onboarding' }] });
            }}>
              <View style={rowLabel}><Text style={{ fontSize: 16, color: theme.color.red }}>Unpair from Mac</Text></View>
              <Icon name="chevronRight" size={16} color={theme.color.inkTertiary} />
            </Row>
          </Group>
        </View>

        {/* Feedback */}
        <View style={{ marginBottom: 22 }}>
          <Group header="Feedback" footer="Bugs and ideas land on your Mac, where you can review and triage them.">
            <Row last onPress={() => setFbOpen(true)}>
              <View style={{ width: 30, height: 30, borderRadius: 8, backgroundColor: theme.color.blue + '24', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="send" size={16} color={theme.color.blue} />
              </View>
              <View style={rowLabel}><Text style={labelText}>Send feedback</Text></View>
              <Icon name="chevronRight" size={16} color={theme.color.inkTertiary} />
            </Row>
          </Group>
        </View>

        {/* About */}
        <View style={{ marginBottom: 28 }}>
          <Group header="About">
            <Row>
              <View style={rowLabel}><Text style={labelText}>Version</Text></View>
              <Text style={{ fontSize: 14, fontWeight: '500', fontFamily: theme.fontFamily.mono, color: theme.color.inkTertiary }}>{appVersion}</Text>
            </Row>
            <Row last>
              <View style={rowLabel}><Text style={labelText}>Relay</Text></View>
              <Text style={{ fontSize: 13, fontWeight: '500', fontFamily: theme.fontFamily.mono, color: theme.color.inkTertiary }}>{relayHost}</Text>
            </Row>
          </Group>
        </View>
      </ScrollView>
      <FeedbackSheet visible={fbOpen} onClose={() => setFbOpen(false)} />
    </View>
  );
}
