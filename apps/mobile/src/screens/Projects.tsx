import React, { useCallback, useState } from 'react';
import { View, Text, Pressable, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme';
import { Icon } from '../Icon';
import { Card } from '../ui';
import { api, type Project, type Job, type ChatSession } from '../api';
import { useLive } from '../useLive';
import { cacheGet, cacheSet } from '../storage';

type ColorName = 'blue' | 'purple' | 'indigo' | 'teal' | 'orange' | 'green' | 'red';
const COLOR_NAMES: ColorName[] = ['blue', 'purple', 'indigo', 'teal', 'orange', 'green', 'red'];

const KIND_LABEL: Record<string, string> = { coding: 'Code', content: 'Content', research: 'Research', design: 'Design', general: 'General' };

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
  // Real-time: a new/updated session or job re-pulls the lists.
  useLive(['session', 'job'], load);

  const sessionCount = (pid: string) => sessions.filter((s) => s.projectId === pid && !s.archived).length;
  const runningCount = (pid: string) => jobs.filter((j) => j.projectId === pid && (j.status === 'running' || j.status === 'pending')).length;

  const confirmDelete = (p: Project) => {
    Alert.alert(
      `Delete “${p.name}”?`,
      'This removes the project and its chats from your Mac. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            setProjects((cur) => cur.filter((x) => x.id !== p.id)); // optimistic
            api.deleteProject(p.id).then(load).catch(() => load());
          },
        },
      ],
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 6, paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
        <View style={{ paddingHorizontal: 20, paddingBottom: 12, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 34, fontWeight: '700', letterSpacing: -0.7, color: theme.color.ink }}>Projects</Text>
            <Text style={{ fontSize: 14, color: theme.color.inkSecondary, marginTop: 3 }}>Your codespace — open a project to see its chats.</Text>
          </View>
          {refreshing && projects.length > 0 ? <ActivityIndicator size="small" color={theme.color.inkTertiary} style={{ marginBottom: 4 }} /> : null}
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
          <View style={{ paddingHorizontal: 16, gap: 10 }}>
            {projects.map((p) => {
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
                        {p.kind ? <Text style={{ fontSize: 13, color: theme.color.inkTertiary }}>· {KIND_LABEL[p.kind] ?? p.kind}</Text> : null}
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
            })}
            <Text style={{ fontSize: 12, color: theme.color.inkTertiary, textAlign: 'center', paddingTop: 8 }}>Long-press a project to delete it.</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}
