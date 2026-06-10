import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, Animated } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme';
import { Icon, type IconName } from '../Icon';
import { Card, SectionLabel, ProgressBar, Mono, useProjects } from '../ui';

type ProjKey = 'atlas' | 'content' | 'scan' | 'brand' | 'infra';

const GATES: { id: string; proj: ProjKey; icon: IconName; tint: keyof ReturnType<typeof useTints>; type: string; summary: string; age: string }[] = [
  { id: 'g1', proj: 'atlas', icon: 'gitMerge', tint: 'blue', type: 'Merge', summary: 'Merge PR #482 — auth refactor', age: '4m' },
  { id: 'g2', proj: 'content', icon: 'send', tint: 'purple', type: 'Publish', summary: 'Publish “Launch week” thread to X', age: '9m' },
  { id: 'g3', proj: 'scan', icon: 'gauge', tint: 'orange', type: 'Over budget', summary: 'Deep run needs $4.10 over cap', age: '1m' },
];
const LIVE: { proj: ProjKey; name: string; verb: string; tint: 'purple' | 'teal'; pct: number; cost: string }[] = [
  { proj: 'atlas', name: 'Refactor auth service', verb: 'Building', tint: 'purple', pct: 64, cost: '0.42' },
  { proj: 'brand', name: 'Export icon set @3x', verb: 'Rendering', tint: 'teal', pct: 88, cost: '0.12' },
  { proj: 'infra', name: 'CI hardening', verb: 'Building', tint: 'purple', pct: 32, cost: '0.18' },
];
const DONE = [
  { ok: true, name: 'Generate OG images', cost: '0.34', when: '20m ago' },
  { ok: true, name: 'Summarize tickets', cost: '0.11', when: '1h ago' },
  { ok: false, name: 'Deploy preview', cost: '0.02', when: '2h ago' },
];

function useTints() {
  const { theme } = useTheme();
  return { blue: theme.color.blue, purple: theme.color.purple, orange: theme.color.orange, teal: theme.color.teal, green: theme.color.green };
}

function Pulse({ color, size = 7 }: { color: string; size?: number }) {
  const a = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(a, { toValue: 0.35, duration: 900, useNativeDriver: true }),
        Animated.timing(a, { toValue: 1, duration: 900, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [a]);
  return <Animated.View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity: a }} />;
}

function NeedsYou({ gates, onApprove }: { gates: typeof GATES; onApprove: (id: string) => void }) {
  const { theme } = useTheme();
  const projects = useProjects();
  const tints = useTints();
  const nav = useNavigation<any>();

  if (!gates.length) {
    return (
      <Card style={{ marginHorizontal: 20, marginBottom: 22, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 18 } as any}>
        <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: 'rgba(52,199,89,0.16)', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="check" size={17} color={theme.color.green} stroke={2.6} />
        </View>
        <Text style={{ fontSize: 16, fontWeight: '500', color: theme.color.inkSecondary }}>Nothing needs you</Text>
      </Card>
    );
  }

  const top = gates[0];
  const p = projects[top.proj];
  const tint = tints[top.tint];

  return (
    <View style={{ marginHorizontal: 20, marginTop: 4, marginBottom: 24 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Icon name="shield" size={15} color={theme.color.red} />
        <Text style={{ fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkSecondary }}>Needs you</Text>
        <View style={{ minWidth: 18, height: 18, paddingHorizontal: 6, borderRadius: 9, backgroundColor: theme.color.red, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700', fontFamily: theme.fontFamily.mono }}>{gates.length}</Text>
        </View>
      </View>

      <View>
        {/* depth stack */}
        {gates.length > 2 ? (
          <View style={{ position: 'absolute', top: 14, left: 14, right: 14, height: 60, borderRadius: 18, backgroundColor: theme.color.bgElevated, borderWidth: 0.5, borderColor: theme.color.separator, opacity: 0.5 }} />
        ) : null}
        {gates.length > 1 ? (
          <View style={{ position: 'absolute', top: 8, left: 8, right: 8, height: 80, borderRadius: 18, backgroundColor: theme.color.bgElevated, borderWidth: 0.5, borderColor: theme.color.separator, opacity: 0.75 }} />
        ) : null}

        <Card style={{ borderRadius: 18, padding: 16 } as any}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 12 }}>
            <View style={{ width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: tint + '24' }}>
              <Icon name={top.icon} size={20} color={tint} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: p.color }} />
                <Text style={{ fontSize: 13, fontWeight: '600', color: theme.color.inkSecondary }}>{p.name}</Text>
                <Text style={{ fontSize: 12, fontFamily: theme.fontFamily.mono, color: theme.color.inkTertiary }}>· {top.age}</Text>
              </View>
              <Text style={{ fontSize: 13, fontWeight: '700', letterSpacing: 0.3, textTransform: 'uppercase', color: tint, marginTop: 5 }}>{top.type}</Text>
            </View>
          </View>
          <Text style={{ fontSize: 17, lineHeight: 23, fontWeight: '500', color: theme.color.ink, marginBottom: 16 }}>{top.summary}</Text>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Pressable onPress={() => onApprove(top.id)} style={{ flex: 1, height: 46, borderRadius: theme.radius.pill, backgroundColor: theme.color.blue, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>Approve</Text>
            </Pressable>
            <Pressable onPress={() => nav.navigate('Approvals')} style={{ flex: 1, height: 46, borderRadius: theme.radius.pill, backgroundColor: theme.color.fillSecondary, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: theme.color.ink, fontSize: 16, fontWeight: '600' }}>Review</Text>
            </Pressable>
          </View>
          {gates.length > 1 ? (
            <Text style={{ textAlign: 'center', marginTop: 12, fontSize: 13, fontWeight: '500', color: theme.color.inkTertiary }}>{gates.length - 1} more · swipe to triage</Text>
          ) : null}
        </Card>
      </View>
    </View>
  );
}

export function HomeScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const projects = useProjects();
  const tints = useTints();
  const nav = useNavigation<any>();
  const [gates, setGates] = useState(GATES);

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 6, paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
        {/* large title header */}
        <View style={{ paddingHorizontal: 20, paddingBottom: 10, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <Text style={{ fontSize: 34, fontWeight: '700', letterSpacing: -0.7, color: theme.color.ink }}>Maestro</Text>
          <Pressable onPress={() => nav.navigate('Notifications')}>
            <Icon name="bell" size={24} color={theme.color.ink} />
            <View style={{ position: 'absolute', top: -2, right: -2, width: 9, height: 9, borderRadius: 5, backgroundColor: theme.color.red, borderWidth: 2, borderColor: theme.color.bg }} />
          </Pressable>
        </View>

        <NeedsYou gates={gates} onApprove={(id) => setGates((g) => g.filter((x) => x.id !== id))} />

        {/* live now */}
        <View style={{ paddingHorizontal: 20, marginBottom: 22 }}>
          <SectionLabel icon="bolt" color={theme.color.purple}>Live now</SectionLabel>
          <View style={{ gap: 9 }}>
            {LIVE.map((j, i) => {
              const p = projects[j.proj];
              const tint = tints[j.tint];
              return (
                <Pressable key={i} onPress={() => nav.navigate('JobTimeline')}>
                  <Card style={{ padding: 14 } as any}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: p.color }} />
                      <Text numberOfLines={1} style={{ flex: 1, fontSize: 16, fontWeight: '600', color: theme.color.ink }}>{j.name}</Text>
                      <Mono style={{ fontSize: 14, fontWeight: '600' }}>${j.cost}</Mono>
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 9 }}>
                      <Pulse color={tint} />
                      <Text style={{ fontSize: 13, fontWeight: '500', color: tint }}>{j.verb}</Text>
                      <View style={{ flex: 1, marginLeft: 4 }}>
                        <ProgressBar pct={j.pct} />
                      </View>
                    </View>
                  </Card>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* today strip */}
        <Pressable onPress={() => nav.navigate('Budget')} style={{ flexDirection: 'row', marginHorizontal: 20, marginBottom: 22, paddingVertical: 14, paddingHorizontal: 18, borderRadius: 14, backgroundColor: theme.color.bgGrouped, borderWidth: 0.5, borderColor: theme.color.separator }}>
          {[['$6.40', 'spend'], ['3', 'scheduled'], ['2 ✓', 'done']].map((s, i) => (
            <React.Fragment key={i}>
              {i > 0 ? <View style={{ width: 1, backgroundColor: theme.color.separator, marginHorizontal: 14 }} /> : null}
              <View style={{ flex: 1 }}>
                <Mono style={{ fontSize: 18, fontWeight: '700' }}>{s[0]}</Mono>
                <Text style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 4 }}>{s[1]}</Text>
              </View>
            </React.Fragment>
          ))}
        </Pressable>

        {/* recently finished */}
        <View style={{ paddingHorizontal: 20 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkSecondary, marginBottom: 11 }}>Recently finished</Text>
          <Card>
            {DONE.map((d, i) => (
              <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 13, paddingHorizontal: 15, borderBottomWidth: i < DONE.length - 1 ? 0.5 : 0, borderBottomColor: theme.color.separator }}>
                <Icon name={d.ok ? 'checkCircle' : 'xCircle'} size={18} color={d.ok ? theme.color.green : theme.color.red} />
                <Text numberOfLines={1} style={{ flex: 1, fontSize: 15, fontWeight: '500', color: theme.color.ink }}>{d.name}</Text>
                <Mono style={{ fontSize: 13, color: theme.color.inkSecondary }}>${d.cost}</Mono>
                <Text style={{ fontSize: 12, color: theme.color.inkTertiary, width: 56, textAlign: 'right' }}>{d.when}</Text>
              </View>
            ))}
          </Card>
        </View>
      </ScrollView>
    </View>
  );
}
