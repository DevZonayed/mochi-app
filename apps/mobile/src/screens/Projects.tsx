import React, { useCallback, useState } from 'react';
import { View, Text, Pressable, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme';
import { Icon, type IconName } from '../Icon';
import { Card } from '../ui';
import { api, type Project, type Job, type ChatSession } from '../api';
import { useLive } from '../useLive';
import { cacheGet, cacheSet } from '../storage';

type ColorName = 'blue' | 'purple' | 'indigo' | 'teal' | 'orange' | 'green' | 'red';
const COLOR_NAMES: ColorName[] = ['blue', 'purple', 'indigo', 'teal', 'orange', 'green', 'red'];

/** Project types, in display order. Anything unrecognized folds into "general". */
const KINDS: { key: string; label: string; icon: IconName }[] = [
  { key: 'coding', label: 'Code', icon: 'command' },
  { key: 'design', label: 'Design', icon: 'image' },
  { key: 'content', label: 'Content', icon: 'clapper' },
  { key: 'research', label: 'Research', icon: 'telescope' },
  { key: 'general', label: 'General', icon: 'folder' },
];
const KIND_KEYS = new Set(KINDS.map((k) => k.key));
const bucketOf = (p: Project): string => (p.kind && KIND_KEYS.has(p.kind) ? p.kind : 'general');

export function ProjectsScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();

  // Seed from cache for an instant render; refresh from the relay underneath.
  const [projects, setProjects] = useState<Project[]>(() => cacheGet('projects', []));
  const [sessions, setSessions] = useState<ChatSession[]>(() => cacheGet('sessions', []));
  const [jobs, setJobs] = useState<Job[]>(() => cacheGet('jobs', []));
  const [loading, setLoading] = useState(projects.length === 0);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<string>('all'); // 'all' or a kind key

  const colorFor = (c: string): string => (COLOR_NAMES.includes(c as ColorName) ? theme.color[c as ColorName] : theme.color.blue);

  const load = useCallback(() => {
    setRefreshing(true);
    Promise.all([api.listProjects(), api.listSessions(), api.listJobs()])
      .then(([ps, ss, js]) => {
        setProjects(ps); setSessions(ss); setJobs(js);
        cacheSet('projects', ps); cacheSet('sessions', ss); cacheSet('jobs', js);
      })
      .catch(() => {})
      .finally(() => { setLoading(false); setRefreshing(false); });
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useLive(['session', 'job'], load);

  const sessionCount = (pid: string) => sessions.filter((s) => s.projectId === pid && !s.archived).length;
  const runningCount = (pid: string) => jobs.filter((j) => j.projectId === pid && (j.status === 'running' || j.status === 'pending')).length;

  const confirmDelete = (p: Project) => {
    Alert.alert(
      `Delete “${p.name}”?`,
      'This removes the project and its chats from your Mac. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => { setProjects((cur) => cur.filter((x) => x.id !== p.id)); api.deleteProject(p.id).then(load).catch(() => load()); } },
      ],
    );
  };

  const renderProject = (p: Project) => {
    const tint = colorFor(p.color);
    const running = runningCount(p.id);
    return (
      <Pressable
        key={p.id}
        onPress={() => nav.navigate('ProjectSessions', { projectId: p.id, name: p.name })}
        onLongPress={() => confirmDelete(p)}
        delayLongPress={400}
      >
        <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 13, padding: 15 } as any}>
          <View style={{ width: 46, height: 46, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: tint + '24' }}>
            <Text style={{ fontSize: 20, fontWeight: '800', color: tint }}>{p.name[0]?.toUpperCase() ?? '?'}</Text>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={{ fontSize: 17, fontWeight: '600', color: theme.color.ink }}>{p.name}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <Text style={{ fontSize: 13, color: theme.color.inkTertiary }}>{sessionCount(p.id)} chat{sessionCount(p.id) === 1 ? '' : 's'}</Text>
              {running > 0 ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, height: 20, borderRadius: 10, backgroundColor: theme.color.purple + '24' }}>
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: theme.color.purple }} />
                  <Text style={{ fontSize: 12, fontWeight: '600', color: theme.color.purple }}>{running} running</Text>
                </View>
              ) : null}
            </View>
          </View>
          <Icon name="chevronRight" size={18} color={theme.color.inkTertiary} />
        </Card>
      </Pressable>
    );
  };

  // Which type tabs to show (only kinds that actually have projects) + counts.
  const present = KINDS.map((k) => ({ ...k, items: projects.filter((p) => bucketOf(p) === k.key) })).filter((g) => g.items.length > 0);
  const shownGroups = filter === 'all' ? present : present.filter((g) => g.key === filter);

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 6, paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
        <View style={{ paddingHorizontal: 20, paddingBottom: 12, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 34, fontWeight: '700', letterSpacing: -0.7, color: theme.color.ink }}>Projects</Text>
            <Text style={{ fontSize: 14, color: theme.color.inkSecondary, marginTop: 3 }}>Your codespace, grouped by type.</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            {refreshing && projects.length > 0 ? <ActivityIndicator size="small" color={theme.color.inkTertiary} /> : null}
            <Pressable onPress={() => nav.navigate('CreateProject')} hitSlop={8} style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.blue }}>
              <Icon name="plus" size={20} color="#fff" stroke={2.4} />
            </Pressable>
          </View>
        </View>

        {loading && projects.length === 0 ? (
          <View style={{ alignItems: 'center', paddingVertical: 80, gap: 14 }}>
            <ActivityIndicator color={theme.color.blue} />
            <Text style={{ fontSize: 14, color: theme.color.inkTertiary }}>Loading your projects…</Text>
          </View>
        ) : projects.length === 0 ? (
          <View style={{ alignItems: 'center', paddingVertical: 70, paddingHorizontal: 36 }}>
            <View style={{ width: 64, height: 64, borderRadius: 20, backgroundColor: theme.color.fillSecondary, alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
              <Icon name="folder" size={30} color={theme.color.inkTertiary} />
            </View>
            <Text style={{ fontSize: 16, fontWeight: '600', color: theme.color.ink, marginBottom: 6 }}>No projects yet</Text>
            <Text style={{ fontSize: 14, lineHeight: 20, color: theme.color.inkSecondary, textAlign: 'center' }}>Create a project on your Mac and it appears here, with all its chat sessions.</Text>
          </View>
        ) : (
          <>
            {/* type filter — only when there's more than one type */}
            {present.length > 1 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingBottom: 14 }}>
                {[{ key: 'all', label: 'All', icon: 'layers' as IconName }, ...present.map((g) => ({ key: g.key, label: g.label, icon: g.icon }))].map((t) => {
                  const on = filter === t.key;
                  return (
                    <Pressable
                      key={t.key}
                      onPress={() => setFilter(t.key)}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 13, borderRadius: 17, backgroundColor: on ? theme.color.blue : theme.color.fillSecondary }}
                    >
                      <Icon name={t.icon} size={15} color={on ? '#fff' : theme.color.inkSecondary} />
                      <Text style={{ fontSize: 14, fontWeight: '600', color: on ? '#fff' : theme.color.inkSecondary }}>{t.label}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            ) : null}

            {/* grouped sections */}
            {shownGroups.map((g) => (
              <View key={g.key} style={{ marginBottom: 18 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingBottom: 9 }}>
                  <Icon name={g.icon} size={15} color={theme.color.inkTertiary} />
                  <Text style={{ fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkSecondary }}>{g.label}</Text>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: theme.color.inkTertiary }}>{g.items.length}</Text>
                </View>
                <View style={{ paddingHorizontal: 16, gap: 10 }}>
                  {g.items.map(renderProject)}
                </View>
              </View>
            ))}
            <Text style={{ fontSize: 12, color: theme.color.inkTertiary, textAlign: 'center', paddingTop: 2 }}>Long-press a project to delete it.</Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}
