import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme';
import type { Theme } from '@maestro/design-tokens';
import { Icon } from '../Icon';
import { api, type CostsData } from '../api';
import { Mono } from '../ui';
import { pullSync, useSyncStore } from '../syncStore';

/** Resolve a live project color NAME ('blue'|'purple'|…) to a theme hex. */
const PROJECT_COLOR_NAMES = ['blue', 'purple', 'indigo', 'teal', 'orange', 'green', 'red'] as const;
type ProjectColorName = (typeof PROJECT_COLOR_NAMES)[number];
function projectColor(theme: Theme, name: string): string {
  return (PROJECT_COLOR_NAMES as readonly string[]).includes(name)
    ? theme.color[name as ProjectColorName]
    : theme.color.blue;
}

const ENGINE_NAME: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };

function clockOf(ts: number): string {
  const d = new Date(ts);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (ts >= today.getTime()) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function BudgetScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();

  const [costs, setCosts] = useState<CostsData | null>(null);
  // Jobs + projects come from the SyncStore so we don't double-fetch on every
  // tab open; only `costs` (a server-computed aggregate) still polls.
  const jobs = useSyncStore((s) => s.jobs);
  const storeProjects = useSyncStore((s) => s.projects);
  const projects = useMemo(() => Object.fromEntries(storeProjects.map((p) => [p.id, p])), [storeProjects]);

  useEffect(() => {
    const stop = api.poll(() => {
      api.costs().then(setCosts).catch(() => {});
      void pullSync();
    });
    return stop;
  }, []);

  const c = costs ?? { today: 0, thisMonth: 0, projectedMonth: 0, byDay: [], byProject: [], byEngine: [], includedCodexRuns: 0, claudeRuns: 0 };
  const maxDay = Math.max(1, ...c.byDay.map(d => d.total));
  const ledger = jobs.filter(j => j.status === 'done' || j.cost > 0).slice(0, 30);

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 6, paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 2, paddingBottom: 4 }}>
          <Pressable onPress={() => nav.navigate('Tabs')} hitSlop={8}>
            <Icon name="arrowLeft" size={22} color={theme.color.blue} />
          </Pressable>
        </View>

        <View style={{ paddingHorizontal: 20, paddingTop: 6, paddingBottom: 10 }}>
          <Text style={{ fontSize: 34, fontWeight: '700', letterSpacing: -0.7, color: theme.color.ink }}>Costs</Text>
          <Text style={{ fontSize: 14, color: theme.color.inkSecondary, marginTop: 3 }}>No caps — runs on your own subscriptions.</Text>
        </View>

        {/* this month hero */}
        <View style={{ alignItems: 'center', paddingTop: 14, paddingBottom: 18 }}>
          <Mono style={{ fontSize: 52, fontWeight: '700', letterSpacing: -1.2, color: theme.color.ink }}>{`$${c.thisMonth.toFixed(2)}`}</Mono>
          <Text style={{ fontSize: 14, fontWeight: '500', color: theme.color.inkTertiary, marginTop: 4 }}>this month</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, backgroundColor: theme.color.green + '24' }}>
            <Icon name="check" size={12} color={theme.color.green} />
            <Text style={{ fontSize: 12, fontWeight: '600', color: theme.color.green }}>No cap — subscription</Text>
          </View>
        </View>

        {/* today + 14d spark */}
        <View style={{ marginHorizontal: 16, marginBottom: 18, padding: 16, borderRadius: 14, backgroundColor: theme.color.bgElevated, borderWidth: 0.5, borderColor: theme.color.separator }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 }}>
            <Text style={{ fontSize: 13, fontWeight: '600', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkTertiary }}>Today</Text>
            <Mono style={{ fontSize: 15, fontWeight: '700' }}>{`$${c.today.toFixed(2)}`}</Mono>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 44 }}>
            {c.byDay.map((d, i) => (
              <View key={i} style={{ flex: 1, height: `${Math.max(3, (d.total / maxDay) * 100)}%`, borderRadius: 2, backgroundColor: i === c.byDay.length - 1 ? theme.color.blue : theme.color.blue + '59' }} />
            ))}
          </View>
          <Text style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 8 }}>{`by day · last 14d · ≈ $${c.projectedMonth.toFixed(0)} projected`}</Text>
        </View>

        {/* by engine */}
        {c.byEngine.length > 0 && (
          <View style={{ paddingHorizontal: 16, marginBottom: 18 }}>
            <Text style={{ fontSize: 13, color: theme.color.inkSecondary, paddingHorizontal: 14, paddingBottom: 7, textTransform: 'uppercase', letterSpacing: 0.4 }}>By engine</Text>
            <View style={{ backgroundColor: theme.color.bgElevated, borderRadius: 12, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: theme.color.separator }}>
              {c.byEngine.map((e, i) => (
                <View key={e.engine} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 46, paddingVertical: 10, paddingHorizontal: 16, borderBottomWidth: i === c.byEngine.length - 1 ? 0 : StyleSheet.hairlineWidth, borderBottomColor: theme.color.separator }}>
                  <Text style={{ flex: 1, fontSize: 15, fontWeight: '500', color: theme.color.ink }}>{ENGINE_NAME[e.engine] ?? e.engine}</Text>
                  <Text style={{ fontSize: 13, color: theme.color.inkTertiary }}>{`${e.jobs} run${e.jobs !== 1 ? 's' : ''}`}</Text>
                  <Mono style={{ fontSize: 14, fontWeight: '600' }}>{`$${e.total.toFixed(2)}`}</Mono>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* by project */}
        {c.byProject.length > 0 && (
          <View style={{ paddingHorizontal: 16, marginBottom: 18 }}>
            <Text style={{ fontSize: 13, color: theme.color.inkSecondary, paddingHorizontal: 14, paddingBottom: 7, textTransform: 'uppercase', letterSpacing: 0.4 }}>By project</Text>
            <View style={{ backgroundColor: theme.color.bgElevated, borderRadius: 12, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: theme.color.separator }}>
              {c.byProject.map((p, i) => (
                <View key={p.projectId} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 46, paddingVertical: 10, paddingHorizontal: 16, borderBottomWidth: i === c.byProject.length - 1 ? 0 : StyleSheet.hairlineWidth, borderBottomColor: theme.color.separator }}>
                  <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: projectColor(theme, p.color) }} />
                  <Text style={{ flex: 1, fontSize: 15, fontWeight: '500', color: theme.color.ink }}>{p.name}</Text>
                  <Mono style={{ fontSize: 14, fontWeight: '600' }}>{`$${p.total.toFixed(2)}`}</Mono>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* ledger */}
        <View style={{ paddingHorizontal: 16, marginBottom: 24 }}>
          <Text style={{ fontSize: 13, color: theme.color.inkSecondary, paddingHorizontal: 14, paddingBottom: 7, textTransform: 'uppercase', letterSpacing: 0.4 }}>Ledger</Text>
          <View style={{ backgroundColor: theme.color.bgElevated, borderRadius: 12, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: theme.color.separator }}>
            {ledger.length === 0 ? (
              <View style={{ padding: 28, alignItems: 'center' }}>
                <Text style={{ fontSize: 14, color: theme.color.inkTertiary }}>No runs yet.</Text>
              </View>
            ) : ledger.map((j, i) => (
              <Pressable key={j.id} onPress={() => nav.navigate('JobTimeline', { id: j.id })} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingVertical: 10, paddingHorizontal: 16, borderBottomWidth: i === ledger.length - 1 ? 0 : StyleSheet.hairlineWidth, borderBottomColor: theme.color.separator }}>
                <Mono style={{ fontSize: 13, fontWeight: '500', color: theme.color.inkTertiary, width: 44 }}>{clockOf(j.createdAt)}</Mono>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={{ fontSize: 14, lineHeight: 17, color: theme.color.ink }}>{j.title}</Text>
                  <Text numberOfLines={1} style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 1 }}>{projects[j.projectId]?.name ?? 'Project'} · {ENGINE_NAME[j.engine ?? 'claude'] ?? j.engine}</Text>
                </View>
                <Mono style={{ fontSize: 14, fontWeight: '600' }}>{`$${j.cost.toFixed(2)}`}</Mono>
              </Pressable>
            ))}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
