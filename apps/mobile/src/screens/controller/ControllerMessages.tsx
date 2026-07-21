/**
 * ControllerMessages — WhatsApp-style messaging tab. Shows a chat list of sessions
 * grouped by project, with the ability to send messages/prompts. Each sent command
 * gets WhatsApp-style delivery indicators (clock=sending, check=sent, double-check=
 * delivered, blue double-check=done). The compose flow uses the existing action
 * controller for delivery tracking.
 *
 * Key design decisions:
 * - Each session is a "conversation" (like a WhatsApp chat)
 * - Starting a job in a project is like "starting a new chat"
 * - Delivery indicators map to ActionReceipt phases
 * - Sent commands are stored in local component state per session
 */
import React from 'react';
import {
  View, Text, FlatList, ScrollView, TextInput, Pressable,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { useTheme } from '../../theme';
import { Icon } from '../../Icon';
import { useController } from './ControllerContext';
import { useActionEnv, familyGranted } from './ActionControls';
import { useActionController, useActionReceipt } from '../../shadowActionRuntime';
import type { ActionIntent } from '../../shadowActionController';
import type { ProjectView, SessionView } from '../../shadowProjectionSelectors';
import {
  Screen, EmptyState, PrimaryButton, KindBadge, MessageBubble,
  ConnBadge, kindColor, useInsets,
  type DeliveryPhase,
} from './parts';

/** Map ActionReceipt phase to WhatsApp delivery phase. */
function receiptToDelivery(phase: string): DeliveryPhase {
  switch (phase) {
    case 'preparing': case 'sent': return 'sending';
    case 'working': return 'sent';
    case 'done': return 'delivered';
    case 'failed': return 'failed';
    default: return 'sending';
  }
}

interface SentMessage {
  id: string;
  text: string;
  timestamp: number;
  intent: ActionIntent;
}

interface ChatRoute {
  view: 'list' | 'chat' | 'newJob';
  projectId?: string;
  sessionId?: string;
}

export function ControllerMessages() {
  const { theme } = useTheme();
  const { state, controller } = useController();
  const insets = useInsets();
  const [route, setRoute] = React.useState<ChatRoute>({ view: 'list' });

  const proj = controller.projection();
  const projects = proj.projects();

  // Gather all sessions across projects, sorted by activity
  const allSessions = React.useMemo(() => {
    const out: Array<SessionView & { projectName?: string; projectKind?: string }> = [];
    for (const p of projects) {
      for (const s of proj.projectSessions(p.id)) {
        out.push({ ...s, projectName: p.name, projectKind: p.kind });
      }
    }
    return out.sort((a, b) => (b.lastActivity ?? b.createdAt ?? 0) - (a.lastActivity ?? a.createdAt ?? 0));
  }, [projects, proj]);

  // Chat detail view
  if (route.view === 'chat' && route.sessionId) {
    const session = proj.session(route.sessionId);
    const project = projects.find((p) => p.id === session?.projectId);
    return (
      <ChatView
        session={session}
        project={project}
        onBack={() => setRoute({ view: 'list' })}
      />
    );
  }

  // New job (start a new chat)
  if (route.view === 'newJob') {
    return (
      <NewJobChat
        projects={projects}
        onBack={() => setRoute({ view: 'list' })}
        onSent={() => setRoute({ view: 'list' })}
      />
    );
  }

  // Chat list
  return (
    <Screen>
      <View style={{ paddingTop: insets.top + 12, paddingHorizontal: 16, paddingBottom: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <Text style={{ fontSize: 32, fontWeight: '700', letterSpacing: -0.6, color: theme.color.ink }}>Messages</Text>
          <Pressable
            onPress={() => setRoute({ view: 'newJob' })}
            accessibilityLabel="Start a new job"
            style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: theme.color.blue, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="plus" size={20} color="#fff" stroke={2.4} />
          </Pressable>
        </View>
      </View>

      {allSessions.length === 0 && projects.length === 0 ? (
        <EmptyState icon="messageCircle" title="No conversations" body="Start a job on your Mac or tap + to begin." />
      ) : (
        <FlatList
          data={allSessions}
          keyExtractor={(s) => s.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 24 }}
          ListHeaderComponent={
            allSessions.length === 0 ? (
              <View style={{ paddingVertical: 20, alignItems: 'center' }}>
                <Text style={{ fontSize: 14, color: theme.color.inkSecondary, textAlign: 'center' }}>
                  No active sessions. Tap + to start a job.
                </Text>
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <ChatListRow
              session={item}
              projectName={item.projectName}
              projectKind={item.projectKind}
              onPress={() => setRoute({ view: 'chat', sessionId: item.id })}
            />
          )}
          ListFooterComponent={
            projects.length > 0 ? (
              <View style={{ marginTop: 16, paddingTop: 16, borderTopWidth: 0.5, borderTopColor: theme.color.separator }}>
                <Text style={{ fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkSecondary, marginBottom: 10 }}>
                  Start a new conversation
                </Text>
                {projects.slice(0, 8).map((p) => (
                  <Pressable
                    key={p.id}
                    onPress={() => setRoute({ view: 'newJob', projectId: p.id })}
                    style={({ pressed }) => ({
                      flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10,
                      opacity: pressed ? 0.6 : 1,
                    })}
                  >
                    <KindBadge kind={p.kind} size={36} />
                    <View style={{ flex: 1 }}>
                      <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: theme.color.ink }}>{p.name ?? 'Project'}</Text>
                    </View>
                    <Icon name="send" size={16} color={theme.color.blue} />
                  </Pressable>
                ))}
              </View>
            ) : null
          }
          initialNumToRender={14}
          windowSize={11}
        />
      )}
    </Screen>
  );
}

// ── chat list row ─────────────────────────────────────────────────────────
function ChatListRow({ session, projectName, projectKind, onPress }: {
  session: SessionView; projectName?: string; projectKind?: string; onPress: () => void;
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
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13,
        borderBottomWidth: 0.5, borderBottomColor: theme.color.separator,
        opacity: pressed ? 0.6 : 1,
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
        <Text numberOfLines={1} style={{ fontSize: 13, color: theme.color.inkSecondary }}>
          {projectName ?? 'Project'} · {session.engine ?? 'Agent'}
        </Text>
      </View>
    </Pressable>
  );
}

// ── chat view (WhatsApp-style) ────────────────────────────────────────────
function ChatView({ session, project, onBack }: {
  session: SessionView | undefined; project: ProjectView | undefined; onBack: () => void;
}) {
  const { theme } = useTheme();
  const { state } = useController();
  const env = useActionEnv();
  const ctrl = useActionController();
  const insets = useInsets();
  const [text, setText] = React.useState('');
  const [sent, setSent] = React.useState<SentMessage[]>([]);
  const [busy, setBusy] = React.useState(false);

  if (!session) { onBack(); return <View style={{ flex: 1 }} />; }

  const canMessage = familyGranted(env.granted, 'send-message');
  const canAutopilot = familyGranted(env.granted, 'set-autopilot');

  const sendMessage = async () => {
    if (busy || text.trim().length === 0 || !canMessage) return;
    const msg = text.trim();
    const intent: ActionIntent = { family: 'send-message', sessionId: session.id, text: msg };
    const id = `msg-${Date.now()}`;
    setSent((prev) => [...prev, { id, text: msg, timestamp: Date.now(), intent }]);
    setText('');
    setBusy(true);
    await ctrl.run(intent);
    setBusy(false);
  };

  const kc = kindColor(project?.kind, theme);

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        {/* Header */}
        <View style={{ paddingTop: insets.top + 4, paddingHorizontal: 8, paddingBottom: 8, borderBottomWidth: 0.5, borderBottomColor: theme.color.separator, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Pressable onPress={onBack} hitSlop={8} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="arrowLeft" size={22} color={theme.color.blue} />
          </Pressable>
          <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: kc + '20', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="messageCircle" size={17} color={kc} />
          </View>
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: '600', color: theme.color.ink }}>{session.title ?? session.codename ?? 'Session'}</Text>
            <Text numberOfLines={1} style={{ fontSize: 12, color: theme.color.inkSecondary }}>{project?.name ?? 'Project'} · {session.engine ?? 'Agent'}</Text>
          </View>
          <ConnBadge online={state.connection.online} />
        </View>

        {/* Messages area */}
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 16, flexGrow: 1, justifyContent: 'flex-end' }}
          keyboardShouldPersistTaps="handled"
        >
          {sent.length === 0 ? (
            <View style={{ alignItems: 'center', paddingVertical: 40 }}>
              <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: theme.color.fillSecondary, alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
                <Icon name="messageCircle" size={26} color={theme.color.inkTertiary} />
              </View>
              <Text style={{ fontSize: 15, fontWeight: '600', color: theme.color.ink, marginBottom: 4 }}>Send a message</Text>
              <Text style={{ fontSize: 13, color: theme.color.inkSecondary, textAlign: 'center', maxWidth: 260 }}>
                Messages you send appear here with delivery status. Type a prompt below.
              </Text>
            </View>
          ) : (
            sent.map((msg) => (
              <SentMessageBubble key={msg.id} message={msg} />
            ))
          )}
        </ScrollView>

        {/* Autopilot toggle */}
        {canAutopilot ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8, borderTopWidth: 0.5, borderTopColor: theme.color.separator }}>
            <Text style={{ fontSize: 13, color: theme.color.inkSecondary }}>Autopilot {session.autopilot ? 'on' : 'off'}</Text>
            <Pressable
              onPress={() => void ctrl.run({ family: 'set-autopilot', sessionId: session.id, enabled: !(session.autopilot ?? false) })}
              disabled={!env.online}
              style={{ paddingHorizontal: 12, height: 30, borderRadius: 15, backgroundColor: session.autopilot ? theme.color.green + '20' : theme.color.fillSecondary, alignItems: 'center', justifyContent: 'center' }}
            >
              <Text style={{ fontSize: 12, fontWeight: '600', color: session.autopilot ? theme.color.green : theme.color.ink }}>
                {session.autopilot ? 'On' : 'Turn on'}
              </Text>
            </Pressable>
          </View>
        ) : null}

        {/* Composer */}
        {canMessage ? (
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingTop: 8, paddingBottom: insets.bottom + 8, borderTopWidth: 0.5, borderTopColor: theme.color.separator, backgroundColor: theme.color.bgElevated }}>
            <View style={{ flex: 1, minHeight: 40, maxHeight: 120, borderRadius: 20, backgroundColor: theme.color.bg, borderWidth: 0.5, borderColor: theme.color.separator, paddingHorizontal: 14, paddingVertical: 8, justifyContent: 'center' }}>
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder="Message..."
                placeholderTextColor={theme.color.inkTertiary}
                multiline
                style={{ fontSize: 15, color: theme.color.ink, maxHeight: 100, paddingVertical: 0 }}
              />
            </View>
            <Pressable
              onPress={() => void sendMessage()}
              disabled={!env.online || text.trim().length === 0 || busy}
              style={({ pressed }) => ({
                width: 40, height: 40, borderRadius: 20,
                backgroundColor: text.trim().length > 0 && env.online ? theme.color.blue : theme.color.fillSecondary,
                alignItems: 'center', justifyContent: 'center',
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Icon name="send" size={18} color={text.trim().length > 0 && env.online ? '#fff' : theme.color.inkTertiary} />
            </Pressable>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, paddingVertical: 12, paddingBottom: insets.bottom + 12, borderTopWidth: 0.5, borderTopColor: theme.color.separator }}>
            <Text style={{ fontSize: 13, color: theme.color.inkTertiary, textAlign: 'center' }}>Read-only access. Request message permission to send.</Text>
          </View>
        )}
      </KeyboardAvoidingView>
    </Screen>
  );
}

/** A single sent message with live delivery indicator from the action receipt. */
function SentMessageBubble({ message }: { message: SentMessage }) {
  const receipt = useActionReceipt(message.intent);
  const phase = receipt.phase === 'idle' ? 'sending' : receiptToDelivery(receipt.phase);
  const time = new Date(message.timestamp);
  const timeStr = `${time.getHours()}:${time.getMinutes().toString().padStart(2, '0')}`;
  return <MessageBubble text={message.text} time={timeStr} delivery={phase} fromMe />;
}

// ── new job chat (start a conversation) ───────────────────────────────────
function NewJobChat({ projects, onBack, onSent }: { projects: ProjectView[]; onBack: () => void; onSent: () => void }) {
  const { theme } = useTheme();
  const env = useActionEnv();
  const ctrl = useActionController();
  const insets = useInsets();
  const [selectedProject, setSelectedProject] = React.useState<string | null>(null);
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
    if (res.ok) {
      setSent(true);
      setTimeout(onSent, 1500);
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        {/* Header */}
        <View style={{ paddingTop: insets.top + 4, paddingHorizontal: 8, paddingBottom: 8, borderBottomWidth: 0.5, borderBottomColor: theme.color.separator, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Pressable onPress={onBack} hitSlop={8} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="arrowLeft" size={22} color={theme.color.blue} />
          </Pressable>
          <Text style={{ fontSize: 18, fontWeight: '700', color: theme.color.ink }}>Start a job</Text>
        </View>

        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled">
          {/* Project selector */}
          <Text style={{ fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkSecondary, marginBottom: 10 }}>
            Select project
          </Text>
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
              {/* Job title */}
              <Text style={{ fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkSecondary, marginBottom: 8 }}>
                Title (optional)
              </Text>
              <TextInput
                value={title}
                onChangeText={setTitle}
                placeholder="Give it a name..."
                placeholderTextColor={theme.color.inkTertiary}
                style={{ height: 44, borderRadius: 12, paddingHorizontal: 14, backgroundColor: theme.color.fillSecondary, borderWidth: 0.5, borderColor: theme.color.separator, color: theme.color.ink, fontSize: 15, marginBottom: 16 }}
              />

              {/* Instructions */}
              <Text style={{ fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkSecondary, marginBottom: 8 }}>
                Instructions
              </Text>
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder="What should the agent do?"
                placeholderTextColor={theme.color.inkTertiary}
                multiline
                style={{ minHeight: 120, borderRadius: 12, paddingHorizontal: 14, paddingTop: 12, backgroundColor: theme.color.fillSecondary, borderWidth: 0.5, borderColor: theme.color.separator, color: theme.color.ink, fontSize: 15, textAlignVertical: 'top', marginBottom: 20 }}
              />

              {/* Send */}
              {sent ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 16 }}>
                  <Icon name="checkCircle" size={22} color={theme.color.green} />
                  <Text style={{ fontSize: 16, fontWeight: '600', color: theme.color.green }}>Job started</Text>
                </View>
              ) : (
                <PrimaryButton
                  title={busy ? 'Sending...' : 'Start job'}
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
