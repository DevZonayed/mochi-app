import React, { useCallback, useState } from 'react';
import { View, Text, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import { useTheme } from '../theme';
import { Icon } from '../Icon';
import { Card } from '../ui';
import { api, type ChatSession, type Job, type MirrorChat } from '../api';
import { useLive, useHostOnline } from '../useLive';
import { cacheGet, cacheSet } from '../storage';

function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function ProjectSessionsScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const projectId: string = route.params?.projectId;
  const name: string = route.params?.name ?? 'Project';

  const [sessions, setSessions] = useState<ChatSession[]>(() => cacheGet(`sessions.${projectId}`, []));
  const [jobs, setJobs] = useState<Job[]>(() => cacheGet(`jobs.${projectId}`, []));
  const [loading, setLoading] = useState(sessions.length === 0);
  // Phase 2: when the Mac is asleep, fall back to the server-mirrored chats.
  // Reads only — no offline writes. `usingMirror` drives the banner below so
  // the user knows what they're looking at.
  const [usingMirror, setUsingMirror] = useState(false);
  const hostOnline = useHostOnline();

  const load = useCallback(() => {
    Promise.all([api.listSessions(projectId), api.listJobs(projectId)])
      .then(([ss, js]) => {
        setSessions(ss); setJobs(js); setUsingMirror(false);
        cacheSet(`sessions.${projectId}`, ss); cacheSet(`jobs.${projectId}`, js);
      })
      .catch(() => { /* errors handled by the mirror fallback below */ })
      .finally(() => setLoading(false));
  }, [projectId]);

  // Mirror fallback — when the Mac just went offline (or the live API just
  // 503'd), pull the server-cached chat list so the screen isn't empty. The
  // mirror has the chat metadata the desktop SyncWorker pushed; jobs aren't
  // mirrored yet (P2.5 followup) so the "running" badge will be empty in
  // mirror mode — acceptable, since the Mac can't be running anything.
  const loadMirror = useCallback(() => {
    api.mirrorListChats(projectId)
      .then((rows: MirrorChat[]) => {
        const mapped: ChatSession[] = rows.map((r) => ({
          id: r.id, projectId: r.projectId ?? projectId, title: r.title,
          createdAt: r.createdAt, updatedAt: r.updatedAt,
          archived: r.archived ? r.updatedAt : undefined,
        }));
        setSessions(mapped); setUsingMirror(true);
        // Don't overwrite the cache — the live list, when the Mac wakes,
        // is still the source of truth.
      })
      .catch(() => { /* network down too; cache from disk stays on screen */ })
      .finally(() => setLoading(false));
  }, [projectId]);

  useFocusEffect(useCallback(() => {
    if (hostOnline === false) loadMirror();
    else load();
  }, [hostOnline, load, loadMirror]));
  useLive(['session', 'job'], load);

  // Per-session: last activity + running state, derived from the project's jobs.
  const meta = useCallback(
    (sid: string): { last: number; running: boolean; snippet: string } => {
      const sj = jobs.filter((j) => j.sessionId === sid).sort((a, b) => b.updatedAt - a.updatedAt);
      const top = sj[0];
      return {
        last: top?.updatedAt ?? 0,
        running: sj.some((j) => j.status === 'running' || j.status === 'pending'),
        snippet: top ? (top.output?.trim() || top.input || '') : '',
      };
    },
    [jobs],
  );

  const active = sessions
    .filter((s) => !s.archived)
    .map((s) => ({ s, ...meta(s.id) }))
    .sort((a, b) => (b.s.pinned ? 1 : 0) - (a.s.pinned ? 1 : 0) || b.last - a.last || b.s.updatedAt - a.s.updatedAt);

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 4, paddingBottom: 96 }} showsVerticalScrollIndicator={false}>
        {/* header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingBottom: 2 }}>
          <Pressable onPress={() => nav.goBack()} hitSlop={8}>
            <Icon name="arrowLeft" size={22} color={theme.color.blue} />
          </Pressable>
        </View>
        <View style={{ paddingHorizontal: 20, paddingTop: 6, paddingBottom: 12 }}>
          <Text numberOfLines={1} style={{ fontSize: 30, fontWeight: '700', letterSpacing: -0.6, color: theme.color.ink }}>{name}</Text>
          <Text style={{ fontSize: 14, color: theme.color.inkSecondary, marginTop: 3 }}>{active.length} chat{active.length === 1 ? '' : 's'}</Text>
        </View>

        {/* Mirror-fallback banner — only when the Mac is offline AND we're
            actually reading from the server cache. Tells the user why the
            "running" badge is missing + that the list might be slightly stale. */}
        {usingMirror ? (
          <View style={{ marginHorizontal: 16, marginBottom: 12, padding: 12, borderRadius: 12, backgroundColor: theme.color.orange + '18', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Icon name="moon" size={16} color={theme.color.orange} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: theme.color.orange }}>Mac is asleep — showing cached chats</Text>
              <Text style={{ fontSize: 12, color: theme.color.inkSecondary, marginTop: 2 }}>Wake your Mac to start a new run or see live status.</Text>
            </View>
          </View>
        ) : null}

        {loading && active.length === 0 ? (
          <View style={{ alignItems: 'center', paddingVertical: 60, gap: 14 }}>
            <ActivityIndicator color={theme.color.blue} />
            <Text style={{ fontSize: 14, color: theme.color.inkTertiary }}>Loading chats…</Text>
          </View>
        ) : active.length === 0 ? (
          <View style={{ alignItems: 'center', paddingVertical: 60, paddingHorizontal: 36 }}>
            <View style={{ width: 64, height: 64, borderRadius: 20, backgroundColor: theme.color.fillSecondary, alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
              <Icon name="chat" size={30} color={theme.color.inkTertiary} />
            </View>
            <Text style={{ fontSize: 16, fontWeight: '600', color: theme.color.ink, marginBottom: 6 }}>No chats yet</Text>
            <Text style={{ fontSize: 14, lineHeight: 20, color: theme.color.inkSecondary, textAlign: 'center' }}>Start a new chat to talk to the agents on your Mac in this project.</Text>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, gap: 10 }}>
            {active.map(({ s, last, running, snippet }) => (
              <Pressable key={s.id} onPress={() => nav.navigate('SessionChat', { projectId, sessionId: s.id, title: s.title })}>
                <Card style={{ padding: 15 } as any}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    {running ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.color.purple }} /> : null}
                    {s.pinned ? <Icon name="bookmark" size={13} color={theme.color.orange} /> : null}
                    <Text numberOfLines={1} style={{ flex: 1, fontSize: 16, fontWeight: '600', color: theme.color.ink }}>{s.title || 'Untitled chat'}</Text>
                    <Text style={{ fontSize: 12, color: theme.color.inkTertiary }}>{last ? ago(last) : ago(s.updatedAt)}</Text>
                    {s.importedFrom ? <Text style={{ fontSize: 11, fontWeight: '600', color: theme.color.inkTertiary, textTransform: 'uppercase' }}>{s.importedFrom}</Text> : null}
                  </View>
                  {snippet ? (
                    <Text numberOfLines={2} style={{ fontSize: 13, lineHeight: 18, color: theme.color.inkSecondary, marginTop: 6 }}>{snippet}</Text>
                  ) : null}
                </Card>
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>

      {/* New chat */}
      <Pressable
        onPress={() => nav.navigate('SessionChat', { projectId })}
        style={({ pressed }) => ({
          position: 'absolute',
          bottom: insets.bottom + 18,
          right: 18,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          height: 52,
          paddingHorizontal: 20,
          borderRadius: 26,
          backgroundColor: theme.color.blue,
          shadowColor: theme.color.blue,
          shadowOpacity: 0.4,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 8 },
          elevation: 6,
          transform: [{ scale: pressed ? 0.95 : 1 }],
        })}
      >
        <Icon name="plus" size={22} color="#fff" stroke={2.4} />
        <Text style={{ fontSize: 16, fontWeight: '600', color: '#fff' }}>New chat</Text>
      </Pressable>
    </View>
  );
}
