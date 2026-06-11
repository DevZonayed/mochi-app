import React, { useState } from 'react';
import { View, Text, Pressable, ScrollView, Animated, StyleSheet, Modal, TextInput, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme';
import { Icon } from '../Icon';
import { Card, Group, Row } from '../ui';
import { api, getPairToken, setPairToken, type Workspace } from '../api';

/* iOS-style toggle switch — animated thumb. */
function MSwitch({ value, onValueChange }: { value: boolean; onValueChange?: (v: boolean) => void }) {
  const { theme } = useTheme();
  const a = React.useRef(new Animated.Value(value ? 1 : 0)).current;
  React.useEffect(() => {
    Animated.timing(a, { toValue: value ? 1 : 0, duration: 220, useNativeDriver: false }).start();
  }, [a, value]);
  const bg = a.interpolate({ inputRange: [0, 1], outputRange: [theme.color.fillSecondary, theme.color.green] });
  const left = a.interpolate({ inputRange: [0, 1], outputRange: [2, 22] });
  return (
    <Pressable onPress={() => onValueChange?.(!value)} hitSlop={6}>
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

type Model = { id: string; name: string; sub: string; cost: number };
const MODELS: Model[] = [
  { id: 'auto', name: 'Auto', sub: 'Routed per task', cost: 0 },
  { id: 'opus', name: 'Opus', sub: 'Most capable', cost: 3 },
  { id: 'sonnet', name: 'Sonnet', sub: 'Balanced', cost: 2 },
  { id: 'haiku', name: 'Haiku', sub: 'Fastest', cost: 1 },
  { id: 'gpt', name: 'GPT-4o', sub: 'Media & vision', cost: 2 },
];

function CostDots({ n }: { n: number }) {
  const { theme } = useTheme();
  if (!n) return <Text style={{ fontSize: 11, fontWeight: '600', color: theme.color.green }}>auto</Text>;
  return (
    <View style={{ flexDirection: 'row', gap: 2 }}>
      {[1, 2, 3].map((d) => (
        <View key={d} style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: d <= n ? theme.color.orange : theme.color.inkTertiary, opacity: d <= n ? 1 : 0.3 }} />
      ))}
    </View>
  );
}

function ModelSwitcher({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { theme } = useTheme();
  const [open, setOpen] = useState(false);
  const cur = MODELS.find((m) => m.id === value) ?? MODELS[0];
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 7, height: 28, paddingHorizontal: 10, borderRadius: 9, backgroundColor: theme.color.fillSecondary }}
      >
        <Icon name="smartphone" size={15} color={cur.id === 'auto' ? theme.color.inkSecondary : theme.color.ink} />
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
            {MODELS.map((m) => {
              const on = m.id === value;
              return (
                <Pressable
                  key={m.id}
                  onPress={() => {
                    onChange(m.id);
                    setOpen(false);
                  }}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                    padding: 9,
                    borderRadius: 8,
                    backgroundColor: on ? theme.color.blue + '1A' : 'transparent',
                  }}
                >
                  <View style={{ width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.fillTertiary }}>
                    <Icon name="smartphone" size={17} color={m.id === 'auto' ? theme.color.inkSecondary : theme.color.ink} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ fontSize: 15, fontWeight: '600', color: theme.color.ink }}>{m.name}</Text>
                    <Text style={{ fontSize: 11, color: theme.color.inkTertiary, marginTop: 2 }}>{m.sub}</Text>
                  </View>
                  {on ? <Icon name="check" size={16} color={theme.color.blue} stroke={2.6} /> : <CostDots n={m.cost} />}
                </Pressable>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const NOTIFS: [string, boolean][] = [
  ['Gates', true],
  ['Completions', true],
  ['Failures', true],
  ['Budget', true],
  ['Publishing', false],
];

export function SettingsScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const [eff, setEff] = useState<Effort>('BALANCED');
  const [model, setModel] = useState('auto');
  const [themeSeg, setThemeSeg] = useState<'Light' | 'Dark' | 'Auto'>('Light');
  const [notifs, setNotifs] = useState<boolean[]>(NOTIFS.map(([, v]) => v));
  const [faceId, setFaceId] = useState(true);
  const [lockApprove, setLockApprove] = useState(true);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);

  // Live workspace/account info for the connection hero (name + budget cap).
  useFocusEffect(
    React.useCallback(() => {
      let alive = true;
      api
        .listWorkspaces()
        .then((wss) => {
          if (alive) setWorkspace(wss[0] ?? null);
        })
        .catch(() => {
          if (alive) setWorkspace(null);
        });
      return () => {
        alive = false;
      };
    }, []),
  );

  const rowLabel: ViewStyle = { flex: 1 };
  const labelText = { fontSize: 16, color: theme.color.ink } as const;

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 6, paddingBottom: 28 }} showsVerticalScrollIndicator={false}>
        {/* large title */}
        <View style={{ paddingHorizontal: 20, paddingBottom: 10 }}>
          <Text style={{ fontSize: 34, fontWeight: '700', letterSpacing: -0.7, color: theme.color.ink }}>Settings</Text>
        </View>

        {/* connection hero */}
        <Card style={{ marginHorizontal: 16, marginBottom: 22, padding: 18, borderRadius: 16 } as ViewStyle}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 13 }}>
            <View style={{ width: 46, height: 46, borderRadius: 13, backgroundColor: theme.color.fillSecondary, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="smartphone" size={24} color={theme.color.inkSecondary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 17, fontWeight: '600', color: theme.color.ink }}>{workspace?.name ?? "Jillur's MacBook Pro"}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 5 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.color.green }} />
                <Text style={{ fontSize: 13, fontWeight: '500', color: theme.color.green }}>Connected via relay · E2EE</Text>
                <Text style={{ fontSize: 12, fontFamily: theme.fontFamily.mono, color: theme.color.inkTertiary }}>· 84 ms</Text>
              </View>
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
            <Pressable style={{ flex: 1, height: 38, borderRadius: theme.radius.pill, backgroundColor: theme.color.fillSecondary, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ fontSize: 14, fontWeight: '600', color: theme.color.ink }}>Test connection</Text>
            </Pressable>
            <Pressable style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(52,199,89,0.14)', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="shield" size={18} color={theme.color.green} />
            </Pressable>
          </View>
        </Card>

        {/* Pairing */}
        <View style={{ marginBottom: 22 }}>
          <Group header="Pairing" footer="The code from your Mac (Maestro → Settings → Devices). Without it, this phone can't reach your Mac.">
            <Row last>
              <View style={rowLabel}>
                <Text style={labelText}>Code</Text>
              </View>
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
          <Group header="Defaults" footer="Applies to new jobs; projects can override.">
            <Row>
              <View style={rowLabel}>
                <Text style={labelText}>Effort</Text>
              </View>
              <EffortDial value={eff} onChange={setEff} />
            </Row>
            <Row last>
              <View style={rowLabel}>
                <Text style={labelText}>Model</Text>
              </View>
              <ModelSwitcher value={model} onChange={setModel} />
            </Row>
          </Group>
        </View>

        {/* Notifications */}
        <View style={{ marginBottom: 22 }}>
          <Group header="Notifications" footer="Destructive approvals always confirm in app.">
            {NOTIFS.map(([name], i) => (
              <Row key={name} last={i === NOTIFS.length - 1}>
                <View style={rowLabel}>
                  <Text style={labelText}>{name}</Text>
                </View>
                <MSwitch value={notifs[i]} onValueChange={(v) => setNotifs((arr) => arr.map((x, j) => (j === i ? v : x)))} />
              </Row>
            ))}
          </Group>
        </View>

        {/* Approvals security */}
        <View style={{ marginBottom: 22 }}>
          <Group header="Approvals security">
            <Row>
              <View style={rowLabel}>
                <Text style={{ fontSize: 16, lineHeight: 19, color: theme.color.ink }}>Face ID for approvals</Text>
              </View>
              <MSwitch value={faceId} onValueChange={setFaceId} />
            </Row>
            <Row last>
              <View style={rowLabel}>
                <Text style={{ fontSize: 16, lineHeight: 19, color: theme.color.ink }}>Lock-screen approve for safe gates</Text>
              </View>
              <MSwitch value={lockApprove} onValueChange={setLockApprove} />
            </Row>
          </Group>
        </View>

        {/* Appearance */}
        <View style={{ marginBottom: 22 }}>
          <Group header="Appearance">
            <Row last>
              <View style={rowLabel}>
                <Text style={labelText}>Theme</Text>
              </View>
              <View style={{ flexDirection: 'row', gap: 3, padding: 2, backgroundColor: theme.color.fillSecondary, borderRadius: 8 }}>
                {(['Light', 'Dark', 'Auto'] as const).map((o) => {
                  const on = themeSeg === o;
                  return (
                    <Pressable
                      key={o}
                      onPress={() => setThemeSeg(o)}
                      style={{
                        paddingVertical: 5,
                        paddingHorizontal: 11,
                        borderRadius: 6,
                        backgroundColor: on ? theme.color.bgElevated : 'transparent',
                        ...(on
                          ? { shadowColor: '#000', shadowOpacity: 0.14, shadowRadius: 2, shadowOffset: { width: 0, height: 1 }, elevation: 1 }
                          : {}),
                      }}
                    >
                      <Text style={{ fontSize: 13, fontWeight: '600', color: on ? theme.color.ink : theme.color.inkSecondary }}>{o}</Text>
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
            <Row onPress={() => nav.navigate('Outbox')}>
              <View style={{ width: 30, height: 30, borderRadius: 8, backgroundColor: 'rgba(255,149,0,0.14)', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="clock" size={16} color={theme.color.orange} />
              </View>
              <View style={rowLabel}>
                <Text style={labelText}>Outbox</Text>
              </View>
              <Text style={{ fontSize: 14, fontWeight: '500', color: theme.color.inkTertiary }}>2 waiting</Text>
              <Icon name="chevronRight" size={16} color={theme.color.inkTertiary} />
            </Row>
            <Row last>
              <View style={rowLabel}>
                <Text style={labelText}>Cached media</Text>
              </View>
              <Text style={{ fontSize: 14, fontWeight: '500', fontFamily: theme.fontFamily.mono, color: theme.color.inkTertiary }}>248 MB</Text>
              <Pressable hitSlop={6}>
                <Text style={{ fontSize: 14, fontWeight: '600', color: theme.color.blue, marginLeft: 8 }}>Clear</Text>
              </Pressable>
            </Row>
          </Group>
        </View>

        {/* This device */}
        <View style={{ marginBottom: 22 }}>
          <Group header="This device">
            <Row>
              <Text style={{ width: 110, fontSize: 16, color: theme.color.inkTertiary }}>Name</Text>
              <View style={rowLabel}>
                <Text style={labelText}>iPhone 15 Pro</Text>
              </View>
            </Row>
            <Row last>
              <View style={rowLabel}>
                <Text style={{ fontSize: 16, color: theme.color.red }}>Unpair from Mac</Text>
              </View>
              <Icon name="chevronRight" size={16} color={theme.color.inkTertiary} />
            </Row>
          </Group>
        </View>

        {/* About */}
        <View style={{ marginBottom: 28 }}>
          <Group header="About">
            <Row>
              <View style={rowLabel}>
                <Text style={labelText}>Version</Text>
              </View>
              <Text style={{ fontSize: 14, fontWeight: '500', fontFamily: theme.fontFamily.mono, color: theme.color.inkTertiary }}>1.4.0 (212)</Text>
            </Row>
            <Row last>
              <View style={rowLabel}>
                <Text style={labelText}>Relay</Text>
              </View>
              <Text style={{ fontSize: 13, fontWeight: '500', fontFamily: theme.fontFamily.mono, color: theme.color.inkTertiary }}>relay.maestro.app</Text>
            </Row>
          </Group>
        </View>
      </ScrollView>
    </View>
  );
}
