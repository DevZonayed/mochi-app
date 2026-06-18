import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, Animated } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme';
import { Icon, type IconName } from '../Icon';
import { Card, SectionLabel, ProgressBar, Mono } from '../ui';
import { api, type DashboardData, type Approval, type Job, type ChatSession, type Project } from '../api';
import { getStr, cacheGet, cacheSet } from '../storage';
import { eventAllowed } from '../notifPrefs';
import { useLive } from '../useLive';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A gentle little nudge at the foot of the dashboard. */
const MOTIVATIONS = [
  'Your agents are on it — go make something great. ✨',
  'Small steps, shipped daily. You’ve got this. 🚀',
  'The Mac does the typing; you do the dreaming. 💭',
  'One prompt at a time. 🌱',
  'Steady hands, big ships. ⛵',
  'Dream it, queue it, ship it. 🛠️',
  'Today’s a good day to build. ☀️',
];

/** Time-of-day greeting. */
function greetingFor(h: number): string {
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}
/** "Wednesday, Jun 18 · 1:37 AM" (manual format — no reliance on Intl). */
function dateTimeLine(now: number): string {
  const d = new Date(now);
  const h = d.getHours();
  const min = String(d.getMinutes()).padStart(2, '0');
  const time = `${(h % 12) || 12}:${min} ${h < 12 ? 'AM' : 'PM'}`;
  return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()} · ${time}`;
}

/** Resolved project label + accent for a live row. */
type ProjVM = { name: string; color: string };

type GateVM = { id: string; proj: ProjVM; icon: IconName; tint: string; type: string; summary: string; age: string };
type LiveVM = { id: string; proj: ProjVM; name: string; verb: string; tint: string; pct: number; cost: string };

/** Color names carried by live projects -> theme accent. */
type ColorName = 'blue' | 'purple' | 'indigo' | 'teal' | 'orange' | 'green' | 'red';
const COLOR_NAMES: readonly ColorName[] = ['blue', 'purple', 'indigo', 'teal', 'orange', 'green', 'red'];
function isColorName(c: string): c is ColorName {
  return (COLOR_NAMES as readonly string[]).includes(c);
}

/** Approval kind -> {type label, icon}. */
const GATE_KIND: Record<Approval['kind'], { type: string; icon: IconName }> = {
  merge: { type: 'Merge', icon: 'gitMerge' },
  publish: { type: 'Publish', icon: 'send' },
  budget: { type: 'Over budget', icon: 'gauge' },
  deploy: { type: 'Deploy', icon: 'bolt' },
  review: { type: 'Review', icon: 'shield' },
};

/** Compact relative age, e.g. "4m", "1h", "now". */
function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Relative "when" suffixed with ago, e.g. "20m ago", "1h ago". */
function agoLong(ts: number): string {
  const a = ago(ts);
  return a === 'now' ? 'just now' : `${a} ago`;
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

function NeedsYou({ gates, onApprove }: { gates: GateVM[]; onApprove: (id: string) => void }) {
  const { theme } = useTheme();
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
  const p = top.proj;
  const tint = top.tint;

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
  const nav = useNavigation<any>();

  const [gates, setGates] = useState<GateVM[]>([]);
  const [live, setLive] = useState<LiveVM[]>([]);
  const [strip, setStrip] = useState({ spend: 0, scheduled: 0, done: 0 });
  const [unread, setUnread] = useState(false);
  // Recent chats — seeded from cache (shared with Projects) for an instant render.
  const [sessions, setSessions] = useState<ChatSession[]>(() => cacheGet('sessions', []));
  const [projects, setProjects] = useState<Project[]>(() => cacheGet('projects', []));
  const [allJobs, setAllJobs] = useState<Job[]>(() => cacheGet('jobs', []));
  const [now, setNow] = useState(Date.now());
  // A cute line picked once per visit.
  const [quip] = useState(() => MOTIVATIONS[Math.floor(Math.random() * MOTIVATIONS.length)]);
  // Live clock for the greeting (minute granularity is enough).
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);

  // Resolve a live project's accent name -> theme color, falling back softly.
  const colorFor = useCallback(
    (name: string): string => (isColorName(name) ? theme.color[name] : theme.color.inkTertiary),
    [theme],
  );

  const apply = useCallback(
    (d: DashboardData) => {
      const projById = new Map<string, ProjVM>();
      for (const gp of d.greetingProjects) projById.set(gp.id, { name: gp.name, color: colorFor(gp.color) });
      const resolve = (projectId: string | null): ProjVM =>
        (projectId ? projById.get(projectId) : undefined) ?? { name: 'Maestro', color: theme.color.inkTertiary };

      setGates(
        d.gates.map((a: Approval): GateVM => {
          const k = GATE_KIND[a.kind];
          const proj = resolve(a.projectId);
          return { id: a.id, proj, icon: k.icon, tint: proj.color, type: k.type, summary: a.title, age: ago(a.createdAt) };
        }),
      );

      setLive(
        d.activeJobs.map((j: Job): LiveVM => {
          const proj = resolve(j.projectId);
          return { id: j.id, proj, name: j.title, verb: j.phase, tint: proj.color, pct: j.progress, cost: j.cost.toFixed(2) };
        }),
      );

      setStrip({ spend: d.budget.spent, scheduled: d.schedule.length, done: d.recentlyCompleted.length });
    },
    [colorFor, theme],
  );

  const refetch = useCallback(async () => {
    try {
      const d = await api.dashboard();
      apply(d);
    } catch {
      /* fail soft — keep last good state */
    }
    // Recent chats: sessions + projects + jobs (cache-then-network, shared cache).
    try {
      const [ss, ps, js] = await Promise.all([api.listSessions(), api.listProjects(), api.listJobs()]);
      setSessions(ss); setProjects(ps); setAllJobs(js);
      cacheSet('sessions', ss); cacheSet('projects', ps); cacheSet('jobs', js);
    } catch {
      /* keep cached chats */
    }
    // Unread badge: any allowed event newer than the last "mark all read".
    try {
      const events = await api.listEvents();
      const readTs = Number(getStr('maestro.mobile.notifReadTs')) || 0;
      setUnread(events.some((e) => eventAllowed(e.kind) && e.ts > readTs));
    } catch {
      /* leave the badge as-is */
    }
  }, [apply]);

  // Refetch whenever the screen regains focus (and on first mount).
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );
  // Real-time: refresh instantly when the Mac reports job/approval/session activity.
  useLive(['job', 'approval', 'session'], () => { void refetch(); });

  const onApprove = useCallback(
    (id: string) => {
      setGates((g) => g.filter((x) => x.id !== id)); // optimistic
      void api
        .approveApproval(id)
        .then(refetch)
        .catch(() => {
          void refetch();
        });
    },
    [refetch],
  );

  const stripCells: [string, string][] = [
    [`$${strip.spend.toFixed(2)}`, 'spend'],
    [`${strip.scheduled}`, 'scheduled'],
    [`${strip.done} ✓`, 'done'],
  ];

  // Latest chats across projects — sorted by last activity, for one-tap resume.
  const projMap = new Map(projects.map((p) => [p.id, p]));
  const recentSessions = sessions
    .filter((s) => !s.archived)
    .map((s) => {
      let last = s.updatedAt;
      for (const j of allJobs) if (j.sessionId === s.id && j.updatedAt > last) last = j.updatedAt;
      return { s, last };
    })
    .sort((a, b) => b.last - a.last)
    .slice(0, 5);

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 6, paddingBottom: 28 }} showsVerticalScrollIndicator={false}>
        {/* greeting + live time */}
        <View style={{ paddingHorizontal: 20, paddingBottom: 16, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: 13, fontWeight: '500', color: theme.color.inkTertiary }}>{dateTimeLine(now)}</Text>
            <Text style={{ fontSize: 30, fontWeight: '700', letterSpacing: -0.6, color: theme.color.ink, marginTop: 3 }}>{greetingFor(new Date(now).getHours())}</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 18, paddingTop: 6 }}>
            <Pressable onPress={() => nav.navigate('Queue')} hitSlop={8}>
              <Icon name="clock" size={23} color={theme.color.ink} />
            </Pressable>
            <Pressable onPress={() => nav.navigate('Notifications')} hitSlop={8}>
              <Icon name="bell" size={24} color={theme.color.ink} />
              {unread ? (
                <View style={{ position: 'absolute', top: -2, right: -2, width: 9, height: 9, borderRadius: 5, backgroundColor: theme.color.red, borderWidth: 2, borderColor: theme.color.bg }} />
              ) : null}
            </Pressable>
          </View>
        </View>

        <NeedsYou gates={gates} onApprove={onApprove} />

        {/* jump back in — latest chats, one tap into the conversation */}
        {recentSessions.length > 0 ? (
          <View style={{ paddingHorizontal: 20, marginBottom: 22 }}>
            <SectionLabel icon="chat" color={theme.color.blue}>Jump back in</SectionLabel>
            <Card>
              {recentSessions.map(({ s, last }, i) => {
                const p = projMap.get(s.projectId);
                const tint = p && isColorName(p.color) ? theme.color[p.color] : theme.color.inkTertiary;
                return (
                  <Pressable
                    key={s.id}
                    onPress={() => nav.navigate('SessionChat', { projectId: s.projectId, sessionId: s.id, title: s.title })}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 13, paddingHorizontal: 15, borderBottomWidth: i < recentSessions.length - 1 ? 0.5 : 0, borderBottomColor: theme.color.separator }}
                  >
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tint }} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: theme.color.ink }}>{s.title || 'Untitled chat'}</Text>
                      <Text numberOfLines={1} style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 2 }}>{p?.name ?? 'Project'} · {agoLong(last)}</Text>
                    </View>
                    <Icon name="chevronRight" size={16} color={theme.color.inkTertiary} />
                  </Pressable>
                );
              })}
            </Card>
          </View>
        ) : null}

        {/* live now */}
        {live.length > 0 ? (
        <View style={{ paddingHorizontal: 20, marginBottom: 22 }}>
          <SectionLabel icon="bolt" color={theme.color.purple}>Live now</SectionLabel>
          <View style={{ gap: 9 }}>
            {live.map((j, i) => {
              const p = j.proj;
              const tint = j.tint;
              return (
                <Pressable key={i} onPress={() => nav.navigate('JobTimeline', { jobId: j.id })}>
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
        ) : null}

        {/* today strip */}
        <Pressable onPress={() => nav.navigate('Budget')} style={{ flexDirection: 'row', marginHorizontal: 20, marginBottom: 22, paddingVertical: 14, paddingHorizontal: 18, borderRadius: 14, backgroundColor: theme.color.bgGrouped, borderWidth: 0.5, borderColor: theme.color.separator }}>
          {stripCells.map((s, i) => (
            <React.Fragment key={i}>
              {i > 0 ? <View style={{ width: 1, backgroundColor: theme.color.separator, marginHorizontal: 14 }} /> : null}
              <View style={{ flex: 1 }}>
                <Mono style={{ fontSize: 18, fontWeight: '700' }}>{s[0]}</Mono>
                <Text style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 4 }}>{s[1]}</Text>
              </View>
            </React.Fragment>
          ))}
        </Pressable>

        {/* a little nudge */}
        <Text style={{ textAlign: 'center', paddingHorizontal: 44, paddingTop: 6, fontSize: 13, lineHeight: 19, color: theme.color.inkTertiary }}>{quip}</Text>
      </ScrollView>
    </View>
  );
}
