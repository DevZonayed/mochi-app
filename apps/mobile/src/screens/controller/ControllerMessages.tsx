/**
 * ControllerMessages — the Chat tab, trimmed to ACTIVE conversations only.
 *
 * Previously this flattened EVERY session across every project into one endless list,
 * which was noise. Now it shows only conversations that are actually live: sessions with
 * a running job, or activity within the last 7 days, newest first, lazy-loaded. Tapping a
 * conversation opens the shared in-session chat window (SessionChatView) with all controls;
 * the "+" starts a new job (a new conversation). Archived / stale sessions live under their
 * project in the Projects tab, not here.
 */
import React from 'react';
import {
  View, Text, FlatList, ScrollView, TextInput, Pressable, ActivityIndicator,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { useTheme } from '../../theme';
import { Icon } from '../../Icon';
import { useController } from './ControllerContext';
import { useActionEnv, familyGranted } from './ActionControls';
import { useActionController } from '../../shadowActionRuntime';
import type { ActionIntent } from '../../shadowActionController';
import type { ProjectView, SessionView } from '../../shadowProjectionSelectors';
import {
  Screen, EmptyState, PrimaryButton, KindBadge, kindColor, useInsets,
} from './parts';
import { SessionChatView } from './SessionChatView';

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // "active" = touched within 7 days
const PAGE = 12;

interface ChatRoute { view: 'list' | 'chat' | 'newJob'; projectId?: string; sessionId?: string }

export function ControllerMessages() {
  const { theme } = useTheme();
  const { controller } = useController();
  const insets = useInsets();
  const [route, setRoute] = React.useState<ChatRoute>({ view: 'list' });
  const [count, setCount] = React.useState(PAGE);

  const proj = controller.projection();
  const projects = proj.projects();

  // Active conversations: non-archived sessions that are running or recently active.
  const conversations = React.useMemo(() => {
    const now = Date.now();
    const out: Array<SessionView & { projectName?: string; projectKind?: string; running: boolean }> = [];
    for (const p of projects) {
      const runningSet = new Set(proj.projectJobs(p.id).filter((j) => j.status === 'running' && j.sessionId).map((j) => j.sessionId!));
      for (const s of proj.projectSessions(p.id)) {
        if (s.archived) continue;
        const running = runningSet.has(s.id);
        const last = s.lastActivity ?? s.createdAt ?? 0;
        if (!running && now - last > RECENT_WINDOW_MS) continue;
        out.push({ ...s, projectName: p.name, projectKind: p.kind, running });
      }
    }
    return out.sort((a, b) => {
      if (a.running !== b.running) return a.running ? -1 : 1;
      return (b.lastActivity ?? b.createdAt ?? 0) - (a.lastActivity ?? a.createdAt ?? 0);
    });
  }, [projects, proj]);

  const visible = conversations.slice(0, count);
  const hasMore = count < conversations.length;

  // Chat detail → shared in-session chat window (with controls)
  if (route.view === 'chat' && route.sessionId) {
    return <SessionChatView sessionId={route.sessionId} onBack={() => setRoute({ view: 'list' })} />;
  }
  if (route.view === 'newJob') {
    return <NewJobChat projects={projects} initialProjectId={route.projectId} onBack={() => setRoute({ view: 'list' })} onSent={() => setRoute({ view: 'list' })} />;
  }

  return (
    <Screen>
      <View style={{ paddingTop: insets.top + 12, paddingHorizontal: 16, paddingBottom: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <Text style={{ fontSize: 32, fontWeight: '700', letterSpacing: -0.6, color: theme.color.ink }}>Chat</Text>
          <Pressable
            onPress={() => setRoute({ view: 'newJob' })}
            accessibilityRole="button"
            accessibilityLabel="Start a new conversation"
            style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: theme.color.blue, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="plus" size={20} color="#fff" stroke={2.4} />
          </Pressable>
        </View>
        <Text style={{ fontSize: 14, color: theme.color.inkSecondary, marginBottom: 8 }}>Active conversations</Text>
      </View>

      {conversations.length === 0 ? (
        <EmptyState icon="messageCircle" title="No active chats" body="Running and recent sessions show here. Tap + to start one." />
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(s) => s.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 24 }}
          renderItem={({ item }) => (
            <ChatListRow
              session={item}
              projectName={item.projectName}
              projectKind={item.projectKind}
              running={item.running}
              onPress={() => setRoute({ view: 'chat', sessionId: item.id })}
            />
          )}
          onEndReached={hasMore ? () => setCount((c) => c + PAGE) : undefined}
          onEndReachedThreshold={0.5}
          ListFooterComponent={hasMore ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 18 }}>
              <ActivityIndicator size="small" color={theme.color.inkTertiary} />
              <Text style={{ fontSize: 13, color: theme.color.inkTertiary }}>Loading more…</Text>
            </View>
          ) : null}
          initialNumToRender={12}
          windowSize={11}
          removeClippedSubviews
        />
      )}
    </Screen>
  );
}

// ── chat list row ───────────────────────────────────────────────────────────
function ChatListRow({ session, projectName, projectKind, running, onPress }: {
  session: SessionView; projectName?: string; projectKind?: string; running: boolean; onPress: () => void;
}) {
  const { theme } = useTheme();
  const kc = kindColor(projectKind, theme);
  const fmtTime = (ms?: number) => {
    if (!ms) return '';
    const d = Date.now() - ms;
    if (d < 60_000) return 'now';
    if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
    if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
    try { return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch { return ''; }
  };

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${session.title ?? session.codename ?? 'Session'}${running ? ', running' : ''}`}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13,
        borderBottomWidth: 0.5, borderBottomColor: theme.color.separator, opacity: pressed ? 0.6 : 1,
      })}
    >
      <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: kc + '20', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="messageCircle" size={22} color={kc} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 16, fontWeight: '600', color: theme.color.ink }}>
            {session.title ?? session.codename ?? 'Session'}
          </Text>
          <Text style={{ fontSize: 12, color: theme.color.inkTertiary, marginLeft: 8 }}>
            {fmtTime(session.lastActivity ?? session.createdAt)}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {running ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: theme.color.green }} /> : null}
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, color: running ? theme.color.green : theme.color.inkSecondary }}>
            {running ? 'Running' : (projectName ?? 'Project')} · {session.engine ?? 'Agent'}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

// ── new job chat (start a conversation) ─────────────────────────────────────
function NewJobChat({ projects, initialProjectId, onBack, onSent }: {
  projects: ProjectView[]; initialProjectId?: string; onBack: () => void; onSent: () => void;
}) {
  const { theme } = useTheme();
  const env = useActionEnv();
  const ctrl = useActionController();
  const insets = useInsets();
  const [selectedProject, setSelectedProject] = React.useState<string | null>(initialProjectId ?? null);
  const [text, setText] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [sent, setSent] = React.useState(false);

  const canStart = familyGranted(env.granted, 'start-job');

  const sendJob = async () => {
    if (busy || !selectedProject || text.trim().length === 0 || !canStart) return;
    const intent: ActionIntent = { family: 'start-job', projectId: selectedProject, input: text.trim(), title: title.trim() || undefined };
    setBusy(true);
    const res = await ctrl.run(intent);
    setBusy(false);
    if (res.ok) { setSent(true); setTimeout(onSent, 1500); }
  };

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <View style={{ paddingTop: insets.top + 4, paddingHorizontal: 8, paddingBottom: 8, borderBottomWidth: 0.5, borderBottomColor: theme.color.separator, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Pressable onPress={onBack} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back" style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="arrowLeft" size={22} color={theme.color.blue} />
          </Pressable>
          <Text style={{ fontSize: 18, fontWeight: '700', color: theme.color.ink }}>New conversation</Text>
        </View>

        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled">
          <Text style={{ fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkSecondary, marginBottom: 10 }}>Select project</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 20 }} contentContainerStyle={{ gap: 8 }}>
            {projects.map((p) => {
              const active = p.id === selectedProject;
              const kc = kindColor(p.kind, theme);
              return (
                <Pressable key={p.id} onPress={() => setSelectedProject(p.id)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, height: 44, borderRadius: 12, backgroundColor: active ? kc + '20' : theme.color.fillSecondary, borderWidth: active ? 1.5 : 0, borderColor: kc }}>
                  <KindBadge kind={p.kind} size={24} />
                  <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: '600', color: active ? kc : theme.color.ink, maxWidth: 120 }}>{p.name ?? 'Project'}</Text>
                </Pressable>
              );
            })}
          </ScrollView>

          {selectedProject ? (
            <>
              <Text style={{ fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkSecondary, marginBottom: 8 }}>Title (optional)</Text>
              <TextInput
                value={title}
                onChangeText={setTitle}
                placeholder="Give it a name…"
                placeholderTextColor={theme.color.inkTertiary}
                style={{ height: 44, borderRadius: 12, paddingHorizontal: 14, backgroundColor: theme.color.fillSecondary, borderWidth: 0.5, borderColor: theme.color.separator, color: theme.color.ink, fontSize: 15, marginBottom: 16 }}
              />
              <Text style={{ fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkSecondary, marginBottom: 8 }}>Instructions</Text>
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder="What should the agent do?"
                placeholderTextColor={theme.color.inkTertiary}
                multiline
                style={{ minHeight: 120, borderRadius: 12, paddingHorizontal: 14, paddingTop: 12, backgroundColor: theme.color.fillSecondary, borderWidth: 0.5, borderColor: theme.color.separator, color: theme.color.ink, fontSize: 15, textAlignVertical: 'top', marginBottom: 20 }}
              />
              {sent ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 16 }}>
                  <Icon name="checkCircle" size={22} color={theme.color.green} />
                  <Text style={{ fontSize: 16, fontWeight: '600', color: theme.color.green }}>Conversation started</Text>
                </View>
              ) : (
                <PrimaryButton
                  title={busy ? 'Sending…' : 'Start conversation'}
                  icon="send"
                  disabled={busy || text.trim().length === 0 || !env.online || !canStart}
                  onPress={() => void sendJob()}
                />
              )}
            </>
          ) : (
            <View style={{ alignItems: 'center', paddingVertical: 20 }}>
              <Text style={{ fontSize: 14, color: theme.color.inkTertiary }}>Select a project to get started.</Text>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
