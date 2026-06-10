import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, Animated } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme';
import { Icon } from '../Icon';
import { Card, Mono, useProjects } from '../ui';

type ProjKey = 'atlas' | 'content' | 'scan' | 'brand' | 'infra';
const PROJ_ORDER: ProjKey[] = ['atlas', 'content', 'scan', 'brand', 'infra'];

const M_JOBS: {
  gated: { proj: ProjKey; name: string; sub: string; cost: string }[];
  running: { proj: ProjKey; name: string; tint: 'purple' | 'teal'; cost: string; el: string }[];
  scheduled: { proj: ProjKey; name: string; countdown: string }[];
  done: { proj: ProjKey; name: string; ok: boolean; cost: string }[];
} = {
  gated: [{ proj: 'atlas', name: 'Merge PR #482', sub: 'auth refactor', cost: '0.31' }],
  running: [
    { proj: 'atlas', name: 'Refactor auth service', tint: 'purple', cost: '0.42', el: '4:21' },
    { proj: 'brand', name: 'Export icon set @3x', tint: 'teal', cost: '0.12', el: '1:08' },
    { proj: 'infra', name: 'CI hardening', tint: 'purple', cost: '0.18', el: '2:55' },
  ],
  scheduled: [
    { proj: 'atlas', name: 'Nightly test suite', countdown: 'in 3h 23m' },
    { proj: 'scan', name: 'Competitor digest', countdown: 'in 7m' },
  ],
  done: [
    { proj: 'brand', name: 'Generate OG images', ok: true, cost: '0.34' },
    { proj: 'content', name: 'Translate docs (ES)', ok: true, cost: '0.46' },
    { proj: 'infra', name: 'Deploy preview', ok: false, cost: '0.02' },
  ],
};

function useTints() {
  const { theme } = useTheme();
  return { purple: theme.color.purple, teal: theme.color.teal } as const;
}

function Pulse({ color, size = 9 }: { color: string; size?: number }) {
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

function ProjAvatar({ id, sel, onPress }: { id: ProjKey | 'all'; sel: boolean; onPress: () => void }) {
  const { theme } = useTheme();
  const projects = useProjects();
  const all = id === 'all';
  const p = all ? { name: 'All', color: theme.color.ink } : projects[id];
  return (
    <Pressable onPress={onPress} style={{ alignItems: 'center', gap: 6, width: 64 }}>
      <View
        style={{
          width: 54,
          height: 54,
          borderRadius: 16,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: all ? theme.color.fillSecondary : p.color + '29',
          borderWidth: sel ? 2 : 0,
          borderColor: theme.color.blue,
        }}
      >
        {all ? (
          <Icon name="layers" size={24} color={theme.color.ink} />
        ) : (
          <Text style={{ fontSize: 20, fontWeight: '800', color: p.color }}>{p.name[0]}</Text>
        )}
        {id === 'scan' ? (
          <View
            style={{
              position: 'absolute',
              top: -3,
              right: -3,
              width: 16,
              height: 16,
              borderRadius: 8,
              backgroundColor: theme.color.red,
              borderWidth: 2,
              borderColor: theme.color.bg,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="lock" size={8} color="#fff" />
          </View>
        ) : null}
      </View>
      <Text numberOfLines={1} style={{ fontSize: 11, fontWeight: '500', maxWidth: 60, color: sel ? theme.color.blue : theme.color.inkSecondary }}>
        {all ? 'All' : p.name.split(' ')[0]}
      </Text>
    </Pressable>
  );
}

function Section({ label, count, tint, children }: { label: string; count: number; tint?: string; children: React.ReactNode }) {
  const { theme } = useTheme();
  return (
    <View style={{ marginBottom: 18 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 20, paddingBottom: 8 }}>
        <Text style={{ fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: tint ?? theme.color.inkSecondary }}>{label}</Text>
        <Mono style={{ fontSize: 12, fontWeight: '600', color: theme.color.inkTertiary }}>{count}</Mono>
      </View>
      <View style={{ marginHorizontal: 16, backgroundColor: theme.color.bgElevated, borderRadius: 14, borderWidth: 0.5, borderColor: theme.color.separator, overflow: 'hidden' }}>
        {children}
      </View>
    </View>
  );
}

export function JobsScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const projects = useProjects();
  const tints = useTints();
  const nav = useNavigation<any>();
  const [filter, setFilter] = useState<ProjKey | 'all'>('all');

  const match = (proj: ProjKey) => filter === 'all' || proj === filter;
  const g = M_JOBS.gated.filter((j) => match(j.proj));
  const r = M_JOBS.running.filter((j) => match(j.proj));
  const s = M_JOBS.scheduled.filter((j) => match(j.proj));
  const d = M_JOBS.done.filter((j) => match(j.proj));

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 6, paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
        {/* large title header */}
        <View style={{ paddingHorizontal: 20, paddingBottom: 10 }}>
          <Text style={{ fontSize: 34, fontWeight: '700', letterSpacing: -0.7, color: theme.color.ink }}>Jobs</Text>
        </View>

        {/* filter row */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 6, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 16 }}
        >
          <ProjAvatar id="all" sel={filter === 'all'} onPress={() => setFilter('all')} />
          {PROJ_ORDER.map((p) => (
            <ProjAvatar key={p} id={p} sel={filter === p} onPress={() => setFilter(p)} />
          ))}
        </ScrollView>

        {g.length > 0 ? (
          <Section label="Gated" count={g.length} tint={theme.color.orange}>
            {g.map((j, i) => (
              <Pressable
                key={i}
                onPress={() => nav.navigate('Approvals')}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 13, paddingHorizontal: 15, borderBottomWidth: i < g.length - 1 ? 0.5 : 0, borderBottomColor: theme.color.separator }}
              >
                <View style={{ width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,149,0,0.15)' }}>
                  <Icon name="arrowRight" size={16} color={theme.color.orange} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ fontSize: 16, lineHeight: 19, fontWeight: '600', color: theme.color.ink }}>{j.name}</Text>
                  <Text style={{ fontSize: 13, color: theme.color.inkTertiary, marginTop: 3 }}>{projects[j.proj].name} · {j.sub}</Text>
                </View>
                <Mono style={{ fontSize: 14, fontWeight: '600', color: theme.color.orange }}>Gated</Mono>
                <Icon name="chevronRight" size={17} color={theme.color.inkTertiary} />
              </Pressable>
            ))}
          </Section>
        ) : null}

        {r.length > 0 ? (
          <Section label="Running" count={r.length}>
            {r.map((j, i) => (
              <Pressable
                key={i}
                onPress={() => nav.navigate('JobTimeline')}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 13, paddingHorizontal: 15, borderBottomWidth: i < r.length - 1 ? 0.5 : 0, borderBottomColor: theme.color.separator }}
              >
                <Pulse color={tints[j.tint]} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={{ fontSize: 16, lineHeight: 19, fontWeight: '600', color: theme.color.ink }}>{j.name}</Text>
                  <Text style={{ fontSize: 13, color: theme.color.inkTertiary, marginTop: 3 }}>{projects[j.proj].name} · {j.el}</Text>
                </View>
                <Mono style={{ fontSize: 14, fontWeight: '600', color: theme.color.ink }}>${j.cost}</Mono>
                <Icon name="chevronRight" size={17} color={theme.color.inkTertiary} />
              </Pressable>
            ))}
          </Section>
        ) : null}

        {s.length > 0 ? (
          <Section label="Scheduled" count={s.length}>
            {s.map((j, i) => (
              <View
                key={i}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 13, paddingHorizontal: 15, borderBottomWidth: i < s.length - 1 ? 0.5 : 0, borderBottomColor: theme.color.separator }}
              >
                <Icon name="clock" size={18} color={theme.color.teal} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ fontSize: 16, lineHeight: 19, fontWeight: '600', color: theme.color.ink }}>{j.name}</Text>
                  <Text style={{ fontSize: 13, color: theme.color.inkTertiary, marginTop: 3 }}>{projects[j.proj].name}</Text>
                </View>
                <Mono style={{ fontSize: 13, fontWeight: '600', color: theme.color.teal }}>{j.countdown}</Mono>
              </View>
            ))}
          </Section>
        ) : null}

        {d.length > 0 ? (
          <Section label="Done today" count={d.length}>
            {d.map((j, i) => (
              <View
                key={i}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 12, paddingHorizontal: 15, borderBottomWidth: i < d.length - 1 ? 0.5 : 0, borderBottomColor: theme.color.separator }}
              >
                <Icon name={j.ok ? 'checkCircle' : 'xCircle'} size={17} color={j.ok ? theme.color.green : theme.color.red} />
                <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 15, lineHeight: 18, fontWeight: '500', color: theme.color.ink }}>{j.name}</Text>
                <Mono style={{ fontSize: 13, fontWeight: '500', color: theme.color.inkSecondary }}>${j.cost}</Mono>
              </View>
            ))}
          </Section>
        ) : null}

        <View style={{ height: 80 }} />
      </ScrollView>

      {/* FAB */}
      <Pressable
        onPress={() => nav.navigate('NewJob')}
        style={({ pressed }) => ({
          position: 'absolute',
          bottom: insets.bottom + 16,
          right: 18,
          width: 58,
          height: 58,
          borderRadius: 29,
          backgroundColor: theme.color.blue,
          alignItems: 'center',
          justifyContent: 'center',
          shadowColor: theme.color.blue,
          shadowOpacity: 0.42,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 8 },
          elevation: 6,
          transform: [{ scale: pressed ? 0.94 : 1 }],
        })}
      >
        <Icon name="plus" size={28} color="#fff" stroke={2.4} />
      </Pressable>
    </View>
  );
}
