import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, Animated } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useTheme } from '../theme';
import { Icon } from '../Icon';
import { Card, Mono } from '../ui';
import { api, type Job } from '../api';

type Meter = { value: string; label: string; accent?: boolean };

/** Map a live color name → theme color hex. */
const PROJECT_COLORS = ['blue', 'purple', 'indigo', 'teal', 'orange', 'green', 'red'] as const;
type ProjectColorName = (typeof PROJECT_COLORS)[number];
function isProjectColor(c: string): c is ProjectColorName {
  return (PROJECT_COLORS as readonly string[]).includes(c);
}

/** Breathing dot — mirrors the design's `.breathe` purple pulse. */
function Breathe({ color, size = 6 }: { color: string; size?: number }) {
  const a = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(a, { toValue: 0.3, duration: 900, useNativeDriver: true }),
        Animated.timing(a, { toValue: 1, duration: 900, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [a]);
  return <Animated.View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity: a }} />;
}

/** Blinking caret at the live edge of the transcript. */
function Caret({ color }: { color: string }) {
  const a = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(a, { toValue: 0, duration: 500, useNativeDriver: true }),
        Animated.timing(a, { toValue: 1, duration: 500, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [a]);
  return <Animated.Text style={{ color, fontWeight: '600', opacity: a }}>▍</Animated.Text>;
}

function MeterStrip({ meters }: { meters: Meter[] }) {
  const { theme } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        paddingHorizontal: 20,
        borderBottomWidth: 0.5,
        borderBottomColor: theme.color.separator,
        backgroundColor: theme.color.bgGrouped,
      }}
    >
      {meters.map((m, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <View style={{ width: 1, height: 26, backgroundColor: theme.color.separator, marginHorizontal: 16 }} /> : null}
          <View style={{ flex: 1 }}>
            <Mono style={{ fontSize: 16, fontWeight: '600', color: m.accent ? theme.color.blue : theme.color.ink }}>{m.value}</Mono>
            <Text style={{ fontSize: 11, color: theme.color.inkTertiary, marginTop: 4 }}>{m.label}</Text>
          </View>
        </React.Fragment>
      ))}
      <Icon name="chevronDown" size={16} color={theme.color.inkTertiary} />
    </View>
  );
}

function PhaseMark({ label }: { label: string }) {
  const { theme } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: theme.color.separator }} />
      <Text style={{ fontSize: 12, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase', color: theme.color.inkTertiary }}>{label}</Text>
      <View style={{ flex: 1, height: 1, backgroundColor: theme.color.separator }} />
    </View>
  );
}

function Narration({ children, caret }: { children: React.ReactNode; caret?: boolean }) {
  const { theme } = useTheme();
  return (
    <Text style={{ fontSize: 17, lineHeight: 27, color: theme.color.ink }}>
      {children}
      {caret ? <Caret color={theme.color.purple} /> : null}
    </Text>
  );
}

/** Format seconds elapsed (since createdAt) as mm:ss. */
function elapsedLabel(createdAt: number, updatedAt: number): string {
  const secs = Math.max(0, Math.floor((updatedAt - createdAt) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function JobTimelineScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  // Callers pass `id` (Budget) or `jobId` (Jobs list) — accept both.
  const routeJobId: string | undefined = route.params?.id ?? route.params?.jobId;

  const [job, setJob] = useState<Job | null>(null);
  const [projects, setProjects] = useState<Record<string, { name: string; color: string }>>({});
  // Latest status, read inside the poll callback to avoid a stale closure.
  const statusRef = useRef<Job['status'] | null>(null);

  // Resolve the job's project → { name, color } from live projects.
  useEffect(() => {
    let alive = true;
    api
      .listProjects()
      .then((list) => {
        if (!alive) return;
        const map: Record<string, { name: string; color: string }> = {};
        for (const p of list) {
          map[p.id] = { name: p.name, color: isProjectColor(p.color) ? theme.color[p.color] : theme.color.blue };
        }
        setProjects(map);
      })
      .catch(() => {
        /* fail soft — header falls back to neutral labels */
      });
    return () => {
      alive = false;
    };
  }, [theme]);

  // Load the target job (by route id, else first running / first), then poll while running.
  useEffect(() => {
    let alive = true;

    const fetchOnce = (): void => {
      const load: Promise<Job | null> = routeJobId
        ? api.getJob(routeJobId)
        : api.listJobs().then((jobs) => jobs.find((j) => j.status === 'running') ?? jobs[0] ?? null);
      load
        .then((j) => {
          if (!alive) return;
          statusRef.current = j ? j.status : null;
          setJob(j);
        })
        .catch(() => {
          /* fail soft — keep last known job */
        });
    };

    // api.poll runs fetchOnce immediately, then every 4s; we gate live refresh
    // on the latest status so polling settles once the job is finished.
    const stop = api.poll(() => {
      const s = statusRef.current;
      if (s === null || s === 'running' || s === 'pending') fetchOnce();
    }, 4000);
    return () => {
      alive = false;
      stop();
    };
  }, [routeJobId]);

  const proj = job ? projects[job.projectId] : undefined;
  const projColor = proj?.color ?? theme.color.purple;
  const projName = proj?.name ?? '';
  const isLive = job?.status === 'running' || job?.status === 'pending';

  const phaseText = job ? (job.phase ? job.phase : job.status) : 'Loading';
  const headerSub = projName ? `${phaseText} · ${projName}` : phaseText;

  const meters: Meter[] = [
    { value: job ? `$${job.cost.toFixed(2)}` : '$0.00', label: 'cost' },
    { value: job ? elapsedLabel(job.createdAt, job.updatedAt) : '0:00', label: 'elapsed' },
    { value: (job ? job.effort : 'balanced').toUpperCase(), label: 'effort', accent: true },
  ];

  const bodyText = job?.output ?? job?.stage ?? '';

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      {/* header */}
      <View
        style={{
          paddingTop: insets.top + 4,
          paddingBottom: 10,
          paddingHorizontal: 16,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          borderBottomWidth: 0.5,
          borderBottomColor: theme.color.separator,
        }}
      >
        <Pressable onPress={() => nav.goBack()} hitSlop={8}>
          <Icon name="arrowLeft" size={22} color={theme.color.blue} />
        </Pressable>
        <View style={{ flex: 1, minWidth: 0, alignItems: 'center' }}>
          <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: '600', color: theme.color.ink }}>
            {job?.title ?? 'Loading…'}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
            <Breathe color={projColor} />
            <Text numberOfLines={1} style={{ fontSize: 12, fontWeight: '500', color: projColor }}>{headerSub}</Text>
          </View>
        </View>
        {isLive && job ? (
          <Pressable hitSlop={8} onPress={() => { void api.cancelJob(job.id).catch(() => {}); }}>
            <Icon name="x" size={22} color={theme.color.red} />
          </Pressable>
        ) : (
          <Pressable hitSlop={8}>
            <Icon name="more" size={22} color={theme.color.inkSecondary} />
          </Pressable>
        )}
      </View>

      <MeterStrip meters={meters} />

      {/* timeline body */}
      <ScrollView
        contentContainerStyle={{ padding: 18, paddingBottom: 90, gap: 16 }}
        showsVerticalScrollIndicator={false}
      >
        <PhaseMark label={`Plan ${job ? '✓' : '…'}`} />
        <Narration>
          {job?.input ?? 'Waiting for job input…'}
        </Narration>

        <PhaseMark label={`${phaseText} ${isLive ? '●' : '✓'}`} />
        <Narration caret={isLive}>
          {bodyText || (job?.error ?? (isLive ? 'Working…' : 'No output yet.'))}
        </Narration>

        <Pressable disabled={!job} onPress={() => job && nav.navigate('DiffReview', { jobId: job.id })}>
          <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 11, padding: 14, borderRadius: 14 } as any}>
            <Icon name="command" size={18} color={theme.color.inkSecondary} />
            <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: theme.color.ink }}>
              {job ? `${job.tokens.toLocaleString()} tokens` : '0 tokens'}
            </Text>
            <Mono style={{ fontSize: 14, fontWeight: '600', color: theme.color.green }}>{`${job ? Math.round(job.progress) : 0}%`}</Mono>
            <Mono style={{ fontSize: 14, fontWeight: '600', color: theme.color.red }}>{`$${job ? job.cost.toFixed(2) : '0.00'}`}</Mono>
            <Icon name="chevronRight" size={16} color={theme.color.inkTertiary} />
          </Card>
        </Pressable>
      </ScrollView>

      {/* jump to live pill */}
      <Pressable
        style={{
          position: 'absolute',
          bottom: insets.bottom + 22,
          alignSelf: 'center',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 7,
          height: 40,
          paddingHorizontal: 18,
          borderRadius: 20,
          backgroundColor: theme.color.blue,
        }}
      >
        <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>Jump to live</Text>
        <Icon name="chevronDown" size={15} color="#fff" />
      </Pressable>
    </View>
  );
}
