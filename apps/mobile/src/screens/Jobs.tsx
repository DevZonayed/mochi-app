import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, Animated } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme';
import { Icon } from '../Icon';
import { Card, Mono } from '../ui';
import { api, type Job, type Project } from '../api';

/** Live project descriptor used to render the filter avatars + row subtitles. */
type LiveProj = { id: string; name: string; color: string };

/** Theme color names a project may carry (mirrors the backend palette). */
type ColorName = 'blue' | 'purple' | 'indigo' | 'teal' | 'orange' | 'green' | 'red';
const COLOR_NAMES: ColorName[] = ['blue', 'purple', 'indigo', 'teal', 'orange', 'green', 'red'];

/** Resolve a job's projectId to a name + theme color via the live project map. */
type ProjResolved = { name: string; color: string };

const cost2 = (n: number): string => n.toFixed(2);

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

function ProjAvatar({ proj, sel, onPress }: { proj: LiveProj | null; sel: boolean; onPress: () => void }) {
  const { theme } = useTheme();
  const all = proj === null;
  const p = all ? { name: 'All', color: theme.color.ink } : proj;
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
  const nav = useNavigation<any>();
  const [filter, setFilter] = useState<string | 'all'>('all');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [projects, setProjects] = useState<LiveProj[]>([]);

  // color-name -> theme hex; default to blue for unknown names.
  const resolveColor = useCallback(
    (color: string): string => {
      const name = (COLOR_NAMES.includes(color as ColorName) ? color : 'blue') as ColorName;
      return theme.color[name];
    },
    [theme],
  );

  // load live jobs + projects (refetch on focus + light polling for a live feel).
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      const load = () => {
        Promise.all([api.listJobs(), api.listProjects()])
          .then(([js, ps]) => {
            if (!alive) return;
            setJobs(js);
            setProjects(ps.map((p: Project): LiveProj => ({ id: p.id, name: p.name, color: resolveColor(p.color) })));
          })
          .catch(() => {
            /* fail soft — keep last good data */
          });
      };
      const stop = api.poll(load, 5000);
      return () => {
        alive = false;
        stop();
      };
    }, [resolveColor]),
  );

  const projById = useCallback(
    (projectId: string | null): ProjResolved => {
      const p = projectId ? projects.find((x) => x.id === projectId) : undefined;
      return p ? { name: p.name, color: p.color } : { name: 'Workspace', color: theme.color.inkSecondary };
    },
    [projects, theme],
  );

  const match = (projectId: string | null) => filter === 'all' || projectId === filter;
  // Map live job statuses into the existing section shapes (markup unchanged).
  const g = jobs
    .filter((j) => j.status === 'pending' && match(j.projectId))
    .map((j) => ({ id: j.id, projectId: j.projectId, name: j.title, sub: j.phase, cost: cost2(j.cost) }));
  const r = jobs
    .filter((j) => j.status === 'running' && match(j.projectId))
    .map((j) => ({ id: j.id, projectId: j.projectId, name: j.title, cost: cost2(j.cost), el: j.phase }));
  const s: { id: string; projectId: string | null; name: string; countdown: string }[] = [];
  const d = jobs
    .filter((j) => (j.status === 'done' || j.status === 'failed') && match(j.projectId))
    .map((j) => ({ id: j.id, name: j.title, ok: j.status === 'done', cost: cost2(j.cost) }));

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
          <ProjAvatar proj={null} sel={filter === 'all'} onPress={() => setFilter('all')} />
          {projects.map((p) => (
            <ProjAvatar key={p.id} proj={p} sel={filter === p.id} onPress={() => setFilter(p.id)} />
          ))}
        </ScrollView>

        {g.length > 0 ? (
          <Section label="Gated" count={g.length} tint={theme.color.orange}>
            {g.map((j, i) => (
              <Pressable
                key={j.id}
                onPress={() => nav.navigate('JobTimeline', { jobId: j.id })}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 13, paddingHorizontal: 15, borderBottomWidth: i < g.length - 1 ? 0.5 : 0, borderBottomColor: theme.color.separator }}
              >
                <View style={{ width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,149,0,0.15)' }}>
                  <Icon name="arrowRight" size={16} color={theme.color.orange} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ fontSize: 16, lineHeight: 19, fontWeight: '600', color: theme.color.ink }}>{j.name}</Text>
                  <Text style={{ fontSize: 13, color: theme.color.inkTertiary, marginTop: 3 }}>{projById(j.projectId).name} · {j.sub}</Text>
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
                key={j.id}
                onPress={() => nav.navigate('JobTimeline', { jobId: j.id })}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 13, paddingHorizontal: 15, borderBottomWidth: i < r.length - 1 ? 0.5 : 0, borderBottomColor: theme.color.separator }}
              >
                <Pulse color={projById(j.projectId).color} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={{ fontSize: 16, lineHeight: 19, fontWeight: '600', color: theme.color.ink }}>{j.name}</Text>
                  <Text style={{ fontSize: 13, color: theme.color.inkTertiary, marginTop: 3 }}>{projById(j.projectId).name} · {j.el}</Text>
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
                key={j.id}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 13, paddingHorizontal: 15, borderBottomWidth: i < s.length - 1 ? 0.5 : 0, borderBottomColor: theme.color.separator }}
              >
                <Icon name="clock" size={18} color={theme.color.teal} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ fontSize: 16, lineHeight: 19, fontWeight: '600', color: theme.color.ink }}>{j.name}</Text>
                  <Text style={{ fontSize: 13, color: theme.color.inkTertiary, marginTop: 3 }}>{projById(j.projectId).name}</Text>
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
                key={j.id}
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
