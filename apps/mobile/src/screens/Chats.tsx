/**
 * Chats — WhatsApp-style recent conversations tab. Shows all active sessions
 * across projects, sorted by last activity, with project color dots, running
 * indicators, and timestamps. One tap to jump into any conversation.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, Pressable, ScrollView, TextInput, RefreshControl } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme';
import { Icon } from '../Icon';
import { Card } from '../ui';
import { pullSync, pullSyncIfStale, useSyncStore } from '../syncStore';

type ColorName = 'blue' | 'purple' | 'indigo' | 'teal' | 'orange' | 'green' | 'red';
const COLOR_NAMES: ColorName[] = ['blue', 'purple', 'indigo', 'teal', 'orange', 'green', 'red'];

function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function ChatsScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const [search, setSearch] = useState('');

  const sessions = useSyncStore((s) => s.sessions);
  const projects = useSyncStore((s) => s.projects);
  const jobs = useSyncStore((s) => s.jobs);
  const syncing = useSyncStore((s) => s.syncing);

  useFocusEffect(useCallback(() => { void pullSyncIfStale(); }, []));
  const onRefresh = useCallback(() => { void pullSync(); }, []);

  const projMap = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);

  // Running sessions (have an active job or updated in last 90s)
  const runningSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const j of jobs) {
      if ((j.status === 'running' || j.status === 'pending') && j.sessionId) ids.add(j.sessionId);
    }
    return ids;
  }, [jobs]);

  // Build chat list sorted by last activity
  const chatList = useMemo(() => {
    const q = search.toLowerCase().trim();
    return sessions
      .filter((s) => !s.archived)
      .filter((s) => !q || (s.title ?? '').toLowerCase().includes(q) || (projMap.get(s.projectId)?.name ?? '').toLowerCase().includes(q))
      .map((s) => {
        let last = s.updatedAt;
        for (const j of jobs) if (j.sessionId === s.id && j.updatedAt > last) last = j.updatedAt;
        const p = projMap.get(s.projectId);
        const tint = p && COLOR_NAMES.includes(p.color as ColorName) ? theme.color[p.color as ColorName] : theme.color.blue;
        const running = runningSessionIds.has(s.id);
        return { s, p, tint, last, running };
      })
      .sort((a, b) => b.last - a.last);
  }, [sessions, projects, jobs, search, theme, projMap, runningSessionIds]);

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + 6, paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={syncing} onRefresh={onRefresh} tintColor={theme.color.inkTertiary} />}
      >
        {/* Header */}
        <View style={{ paddingHorizontal: 20, paddingBottom: 12 }}>
          <Text style={{ fontSize: 34, fontWeight: '700', letterSpacing: -0.7, color: theme.color.ink }}>Chats</Text>
          <Text style={{ fontSize: 14, color: theme.color.inkSecondary, marginTop: 3 }}>
            {chatList.length} conversation{chatList.length !== 1 ? 's' : ''} across {projects.length} project{projects.length !== 1 ? 's' : ''}
          </Text>
        </View>

        {/* Search bar */}
        <View style={{ marginHorizontal: 16, marginBottom: 14 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 40, paddingHorizontal: 12, borderRadius: 12, backgroundColor: theme.color.fillSecondary }}>
            <Icon name="search" size={16} color={theme.color.inkTertiary} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search chats..."
              placeholderTextColor={theme.color.inkTertiary}
              style={{ flex: 1, fontSize: 15, color: theme.color.ink, paddingVertical: 0 }}
              returnKeyType="search"
            />
            {search ? (
              <Pressable onPress={() => setSearch('')} hitSlop={8}>
                <Icon name="x" size={14} color={theme.color.inkTertiary} />
              </Pressable>
            ) : null}
          </View>
        </View>

        {/* Chat list */}
        {chatList.length === 0 ? (
          <View style={{ alignItems: 'center', paddingVertical: 56, paddingHorizontal: 28 }}>
            <View style={{ width: 76, height: 76, borderRadius: 22, backgroundColor: theme.color.blue + '18', alignItems: 'center', justifyContent: 'center', marginBottom: 18 }}>
              <Icon name="messageCircle" size={34} color={theme.color.blue} />
            </View>
            <Text style={{ fontSize: 19, fontWeight: '700', color: theme.color.ink, marginBottom: 8 }}>
              {search ? 'No matches' : 'No chats yet'}
            </Text>
            <Text style={{ fontSize: 14, lineHeight: 20, color: theme.color.inkSecondary, textAlign: 'center' }}>
              {search ? 'Try a different search term.' : 'Start a job from the Projects tab to begin a conversation.'}
            </Text>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, gap: 2 }}>
            {chatList.map(({ s, p, tint, last, running }, i) => (
              <Pressable
                key={s.id}
                onPress={() => nav.navigate('SessionChat', { projectId: s.projectId, sessionId: s.id, title: s.title })}
              >
                <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 } as any}>
                  {/* Avatar with project initial */}
                  <View style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: tint + '20' }}>
                    <Text style={{ fontSize: 18, fontWeight: '800', color: tint }}>{(p?.name ?? '?')[0]?.toUpperCase()}</Text>
                    {running ? (
                      <View style={{ position: 'absolute', bottom: -1, right: -1, width: 14, height: 14, borderRadius: 7, backgroundColor: theme.color.green, borderWidth: 2.5, borderColor: theme.color.bgElevated }} />
                    ) : null}
                  </View>

                  {/* Content */}
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
                      <Text numberOfLines={1} style={{ flex: 1, fontSize: 16, fontWeight: '600', color: theme.color.ink }}>{s.title || 'Untitled chat'}</Text>
                      <Text style={{ fontSize: 12, fontWeight: '500', color: running ? theme.color.green : theme.color.inkTertiary, marginLeft: 8 }}>
                        {ago(last)}
                      </Text>
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: tint }} />
                      <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, color: theme.color.inkTertiary }}>
                        {p?.name ?? 'Project'}
                        {running ? ' · Working...' : ''}
                      </Text>
                      {running ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, height: 18, borderRadius: 9, backgroundColor: theme.color.green + '20' }}>
                          <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: theme.color.green }} />
                          <Text style={{ fontSize: 11, fontWeight: '700', color: theme.color.green }}>Live</Text>
                        </View>
                      ) : null}
                    </View>
                  </View>

                  <Icon name="chevronRight" size={16} color={theme.color.inkTertiary} />
                </Card>
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
