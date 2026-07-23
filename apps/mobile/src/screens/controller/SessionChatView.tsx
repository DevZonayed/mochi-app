/**
 * SessionChatView — the in-session chat window with ALL session controls in one place.
 *
 * Reached by drilling Projects → type → project → session (and from the Chat tab). It is
 * the single "control surface" for a session: a messaging thread (sent prompts with live
 * WhatsApp-style delivery), a compact control-chip row (autopilot toggle, pending-approval
 * indicator, Stop a running job), a live "working" indicator derived from the running job,
 * and a composer. Every control renders ONLY when the current verified grant permits it and
 * is disabled (never a dead button) when offline. No optimistic mutation, no raw ids/paths.
 */
import React from 'react';
import {
  View, Text, ScrollView, TextInput, Pressable, ActivityIndicator,
  KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import { useTheme } from '../../theme';
import { Icon, type IconName } from '../../Icon';
import { useController } from './ControllerContext';
import { useActionEnv, familyGranted } from './ActionControls';
import { requestedCapabilitiesFor, ACTION_FAMILIES } from '../../shadowActionCapabilities';
import { useActionController, useActionReceipt } from '../../shadowActionRuntime';
import type { ActionIntent } from '../../shadowActionController';
import type { JobView, TranscriptEntry } from '../../shadowProjectionSelectors';
import {
  Screen, ConnBadge, MessageBubble, kindColor, useInsets, type DeliveryPhase,
} from './parts';

/** Map an ActionReceipt phase to a WhatsApp-style delivery phase. */
function receiptToDelivery(phase: string): DeliveryPhase {
  switch (phase) {
    case 'preparing': case 'sent': return 'sending';
    case 'working': return 'sent';
    case 'done': return 'delivered';
    case 'failed': return 'failed';
    default: return 'sending';
  }
}

interface SentMessage { id: string; text: string; timestamp: number; intent: ActionIntent }

export function SessionChatView({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
  const { theme } = useTheme();
  const { state, controller } = useController();
  const env = useActionEnv();
  const ctrl = useActionController();
  const insets = useInsets();
  const [text, setText] = React.useState('');
  const [sent, setSent] = React.useState<SentMessage[]>([]);
  const [busy, setBusy] = React.useState(false);
  const scrollRef = React.useRef<ScrollView>(null);

  const proj = controller.projection();
  const session = proj.session(sessionId);
  const project = session ? proj.projects().find((p) => p.id === session.projectId) : undefined;

  // Guard: session vanished (revoked/tombstoned) → pop back.
  if (!session) { onBack(); return <View style={{ flex: 1 }} />; }

  const jobs = proj.projectJobs(session.projectId)
    .filter((j) => j.sessionId === session.id)
    .sort((a, b) => (a.createdAt ?? a.lastActivity ?? 0) - (b.createdAt ?? b.lastActivity ?? 0));
  const runningJob = jobs.find((j) => j.status === 'running' || j.status === 'active');
  const approvals = proj.pendingApprovals().filter((a) => a.projectId === session.projectId);

  const canMessage = familyGranted(env.granted, 'send-message');
  const canAutopilot = familyGranted(env.granted, 'set-autopilot');
  const canCancel = familyGranted(env.granted, 'cancel-job');
  const online = state.connection.online;
  const kc = kindColor(project?.kind, theme);

  const sendMessage = async () => {
    if (busy || text.trim().length === 0 || !canMessage) return;
    const msg = text.trim();
    const intent: ActionIntent = { family: 'send-message', sessionId: session.id, text: msg };
    setSent((prev) => [...prev, { id: `msg-${Date.now()}`, text: msg, timestamp: Date.now(), intent }]);
    setText('');
    setBusy(true);
    await ctrl.run(intent);
    setBusy(false);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 60);
  };

  const toggleAutopilot = () => {
    if (!online) return;
    void ctrl.run({ family: 'set-autopilot', sessionId: session.id, enabled: !(session.autopilot ?? false) });
  };
  const stopRunning = () => {
    if (!online || !runningJob) return;
    void ctrl.run({ family: 'cancel-job', jobId: runningJob.id });
  };

  const hasChips = canAutopilot || approvals.length > 0 || (!!runningJob && canCancel);

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        {/* Header */}
        <View style={{ paddingTop: insets.top + 4, paddingHorizontal: 8, paddingBottom: 8, borderBottomWidth: 0.5, borderBottomColor: theme.color.separator, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Pressable onPress={onBack} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back" style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="arrowLeft" size={22} color={theme.color.blue} />
          </Pressable>
          <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: kc + '20', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="messageCircle" size={17} color={kc} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: '600', color: theme.color.ink }}>{session.title ?? session.codename ?? 'Session'}</Text>
            <Text numberOfLines={1} style={{ fontSize: 12, color: theme.color.inkSecondary }}>
              {[project?.name, session.engine, session.model].filter(Boolean).join(' · ') || 'Session'}
            </Text>
          </View>
          <ConnBadge online={online} />
        </View>

        {/* Control chips */}
        {hasChips ? (
          <ScrollView
            horizontal showsHorizontalScrollIndicator={false}
            style={{ flexGrow: 0, borderBottomWidth: 0.5, borderBottomColor: theme.color.separator }}
            contentContainerStyle={{ gap: 8, paddingHorizontal: 12, paddingVertical: 8, alignItems: 'center' }}
          >
            {canAutopilot ? (
              <Chip
                icon="bolt"
                label={session.autopilot ? 'Autopilot on' : 'Autopilot off'}
                color={session.autopilot ? theme.color.green : theme.color.inkSecondary}
                filled={!!session.autopilot}
                disabled={!online}
                onPress={toggleAutopilot}
              />
            ) : null}
            {approvals.length > 0 ? (
              <Chip icon="alert" label={`Approvals ${approvals.length}`} color={theme.color.orange} filled />
            ) : null}
            {runningJob && canCancel ? (
              <Chip icon="x" label="Stop" color={theme.color.red} outline disabled={!online} onPress={stopRunning} />
            ) : null}
          </ScrollView>
        ) : null}

        {/* Message thread */}
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 16, flexGrow: 1, justifyContent: 'flex-end' }}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
        >
          {sent.length === 0 && jobs.length === 0 ? (
            <View style={{ alignItems: 'center', paddingVertical: 40 }}>
              <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: theme.color.fillSecondary, alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
                <Icon name="messageCircle" size={26} color={theme.color.inkTertiary} />
              </View>
              <Text style={{ fontSize: 15, fontWeight: '600', color: theme.color.ink, marginBottom: 4 }}>No activity yet</Text>
              <Text style={{ fontSize: 13, color: theme.color.inkSecondary, textAlign: 'center', maxWidth: 260 }}>
                Jobs and prompts for this session appear here. Send a message below to continue the work.
              </Text>
            </View>
          ) : (
            <>
              {jobs.map((j) => <TurnBlock key={j.id} job={j} />)}
              {sent.map((m) => <SentMessageBubble key={m.id} message={m} />)}
            </>
          )}
        </ScrollView>

        {/* Composer */}
        {canMessage ? (
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingTop: 8, paddingBottom: insets.bottom + 8, borderTopWidth: 0.5, borderTopColor: theme.color.separator, backgroundColor: theme.color.bgElevated }}>
            <View style={{ flex: 1, minHeight: 40, maxHeight: 120, borderRadius: 20, backgroundColor: theme.color.bg, borderWidth: 0.5, borderColor: theme.color.separator, paddingHorizontal: 14, paddingVertical: 8, justifyContent: 'center' }}>
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder="Message…"
                placeholderTextColor={theme.color.inkTertiary}
                accessibilityLabel="Message this session"
                multiline
                style={{ fontSize: 15, color: theme.color.ink, maxHeight: 100, paddingVertical: 0 }}
              />
            </View>
            <Pressable
              onPress={() => void sendMessage()}
              disabled={!online || text.trim().length === 0 || busy}
              accessibilityRole="button"
              accessibilityLabel="Send message"
              style={({ pressed }) => ({
                width: 40, height: 40, borderRadius: 20,
                backgroundColor: text.trim().length > 0 && online ? theme.color.blue : theme.color.fillSecondary,
                alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1,
              })}
            >
              <Icon name="send" size={18} color={text.trim().length > 0 && online ? '#fff' : theme.color.inkTertiary} />
            </Pressable>
          </View>
        ) : (
          <RequestControlButton bottomInset={insets.bottom} />
        )}
      </KeyboardAvoidingView>
    </Screen>
  );
}

/** A compact control chip (filled / outline / neutral). Non-pressable when `onPress` omitted. */
function Chip({ icon, label, color, filled, outline, disabled, onPress }: {
  icon: IconName; label: string; color: string; filled?: boolean; outline?: boolean; disabled?: boolean; onPress?: () => void;
}) {
  const { theme } = useTheme();
  const bg = filled ? color + '20' : outline ? 'transparent' : theme.color.fillSecondary;
  const border = outline ? color + '80' : filled ? color + '30' : theme.color.separator;
  const fg = filled || outline ? color : theme.color.ink;
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled || !onPress}
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLabel={label}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 12,
        borderRadius: 17, backgroundColor: bg, borderWidth: 0.5, borderColor: border, opacity: disabled ? 0.5 : 1,
      }}
    >
      <Icon name={icon} size={14} color={fg} />
      <Text style={{ fontSize: 13, fontWeight: '600', color: fg }}>{label}</Text>
    </Pressable>
  );
}

// The full read+write+execute capability set: the read floor + all six action families +
// screen view. Requested at re-enrollment; the Mac operator approves it (never self-granted).
const FULL_CONTROL_CAPS = requestedCapabilitiesFor('control', ACTION_FAMILIES.map((f) => f.key), true);

/**
 * The read-only footer, upgraded to an actionable CTA. One tap re-enrolls THIS device to its
 * Mac requesting full control (read + write + execute + screen), then the operator approves on
 * the Mac. Destructive (pauses the current view-only grant until approved), so it confirms first.
 */
function RequestControlButton({ bottomInset }: { bottomInset: number }) {
  const { theme } = useTheme();
  const { controller } = useController();
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState<string | null>(null);

  const run = async () => {
    setBusy(true); setNote(null);
    try {
      const macsRes = await controller.listAccountMacs();
      if (!macsRes.ok || macsRes.macs.length === 0) { setNote('No Mac found to connect to. Make sure your Mac is online.'); return; }
      const target = macsRes.macs.find((m) => m.online) ?? macsRes.macs[0];
      await controller.cancelEnrollment();                        // clean slate (mutable caps)
      await controller.setRequestedCapabilities(FULL_CONTROL_CAPS);
      const begun = await controller.beginAccountEnrollment(target.hostDeviceId);
      if (!begun.ok) { setNote(begun.reason ?? 'Could not start the request.'); return; }
      const sent = await controller.confirmEnrollment();
      if (!sent.ok) { setNote(sent.reason ?? 'Could not send the request.'); return; }
      setNote(`Requested from “${target.name ?? 'your Mac'}”. Approve it on your Mac: Settings → Controllers.`);
    } catch {
      setNote('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const confirm = () => {
    if (busy) return;
    Alert.alert(
      'Request full control?',
      'This asks your Mac to grant read, write, and execute access to this device. You’ll approve it on your Mac (Settings → Controllers). Your current view-only access pauses until you approve.',
      [{ text: 'Cancel', style: 'cancel' }, { text: 'Request', onPress: () => { void run(); } }],
    );
  };

  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: bottomInset + 12, borderTopWidth: 0.5, borderTopColor: theme.color.separator, backgroundColor: theme.color.bgElevated }}>
      <Pressable
        onPress={confirm}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Request full control access"
        style={({ pressed }) => ({
          flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
          minHeight: 48, borderRadius: 24, backgroundColor: theme.color.blue,
          opacity: busy ? 0.6 : pressed ? 0.85 : 1,
        })}
      >
        {busy ? <ActivityIndicator size="small" color="#fff" /> : <Icon name="bolt" size={18} color="#fff" />}
        <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff' }}>{busy ? 'Requesting…' : 'Request full control'}</Text>
      </Pressable>
      <Text style={{ fontSize: 12, color: note ? theme.color.ink : theme.color.inkTertiary, textAlign: 'center', marginTop: 8, lineHeight: 17 }}>
        {note ?? 'Read-only now — unlock sending messages, starting sessions & actions.'}
      </Text>
    </View>
  );
}

/** A sent prompt bubble with a live delivery indicator from its action receipt. */
function SentMessageBubble({ message }: { message: SentMessage }) {
  const receipt = useActionReceipt(message.intent);
  const phase = receipt.phase === 'idle' ? 'sending' : receiptToDelivery(receipt.phase);
  const t = new Date(message.timestamp);
  const timeStr = `${t.getHours()}:${t.getMinutes().toString().padStart(2, '0')}`;
  return <MessageBubble text={message.text} time={timeStr} delivery={phase} fromMe />;
}

/** A left-aligned "working" indicator derived from the running job (truthful phase + progress). */
function WorkingBubble({ job }: { job: JobView }) {
  const { theme } = useTheme();
  const pct = typeof job.progress === 'number' && Number.isFinite(job.progress)
    ? Math.max(0, Math.min(1, job.progress > 1 ? job.progress / 100 : job.progress))
    : null;
  const label = [job.phase, job.stage].filter(Boolean).join(' · ') || 'Working…';
  return (
    <View style={{ alignSelf: 'flex-start', maxWidth: '86%', marginVertical: 3 }}>
      <View style={{ backgroundColor: theme.color.bgElevated, borderRadius: 18, borderBottomLeftRadius: 4, borderWidth: 0.5, borderColor: theme.color.separator, paddingHorizontal: 14, paddingVertical: 10, minWidth: 200 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <ActivityIndicator size="small" color={theme.color.blue} />
          <Text style={{ flex: 1, fontSize: 13, fontWeight: '600', color: theme.color.inkSecondary }} numberOfLines={1}>{(job.engine ?? 'agent')} · working…</Text>
        </View>
        <Text style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 3 }} numberOfLines={1}>{label}</Text>
        {pct !== null ? (
          <View style={{ height: 4, borderRadius: 2, backgroundColor: theme.color.fillSecondary, marginTop: 8, overflow: 'hidden' }}>
            <View style={{ width: `${Math.round(pct * 100)}%`, height: 4, borderRadius: 2, backgroundColor: theme.color.blue }} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** Status dot color + label for a completed/queued/failed job. */
function jobStatusMeta(status: string | undefined, theme: ReturnType<typeof useTheme>['theme']): { color: string; label: string } {
  switch (status) {
    case 'done': case 'completed': case 'succeeded': return { color: theme.color.green, label: 'Done' };
    case 'failed': case 'error': return { color: theme.color.red, label: 'Failed' };
    case 'blocked': return { color: theme.color.orange, label: 'Blocked' };
    case 'cancelled': case 'canceled': return { color: theme.color.inkTertiary, label: 'Cancelled' };
    case 'queued': case 'pending': return { color: theme.color.orange, label: 'Queued' };
    default: return { color: theme.color.inkTertiary, label: status ?? 'Job' };
  }
}

function clockOf(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  try { const t = new Date(ms); return `${t.getHours()}:${t.getMinutes().toString().padStart(2, '0')}`; } catch { return ''; }
}

/**
 * One conversation TURN. A job models a turn: `job.title` is the USER's prompt for that
 * turn (rendered as a right-aligned user bubble), and the assistant's side shows the live
 * work (running) or the outcome (done/failed). When the host projects the assistant
 * transcript (message/thinking/tool text), it renders in the assistant bubble here.
 */
function TurnBlock({ job }: { job: JobView }) {
  const running = job.status === 'running' || job.status === 'active';
  const timeStr = clockOf(job.createdAt ?? job.lastActivity);
  const userText = job.input ?? job.title;
  const hasTranscript = !!job.transcript && job.transcript.length > 0;
  return (
    <View style={{ marginBottom: 8 }}>
      {userText ? <MessageBubble text={userText} time={timeStr} fromMe /> : null}
      {hasTranscript ? <TranscriptFlow items={job.transcript!} /> : null}
      {running ? <WorkingBubble job={job} /> : (!hasTranscript ? <AssistantBubble job={job} /> : null)}
    </View>
  );
}

/** Renders the agent's structured run for a turn: assistant text, thinking, tool activity,
 *  and results — the real conversation flow projected from the host (redacted + bounded). */
function TranscriptFlow({ items }: { items: readonly TranscriptEntry[] }) {
  return <>{items.map((it, i) => <TranscriptRow key={i} item={it} />)}</>;
}

function TranscriptRow({ item }: { item: TranscriptEntry }) {
  const { theme } = useTheme();
  const leftBubble = (child: React.ReactNode, tint?: string) => (
    <View style={{ alignSelf: 'flex-start', maxWidth: '88%', marginVertical: 3 }}>
      <View style={{ backgroundColor: tint ?? theme.color.bgElevated, borderRadius: 16, borderBottomLeftRadius: 4, borderWidth: 0.5, borderColor: theme.color.separator, paddingHorizontal: 13, paddingVertical: 9 }}>
        {child}
      </View>
    </View>
  );

  // Assistant's spoken message / final result — the primary chat content.
  if (item.kind === 'text' || item.kind === 'result') {
    if (!item.text) return null;
    return leftBubble(<Text style={{ fontSize: 15, lineHeight: 21, color: theme.color.ink }}>{item.text}</Text>);
  }
  // Reasoning — de-emphasised, italic.
  if (item.kind === 'thinking') {
    if (!item.text) return null;
    return leftBubble(
      <View style={{ flexDirection: 'row', gap: 7 }}>
        <Icon name="spark" size={13} color={theme.color.inkTertiary} />
        <Text style={{ flex: 1, fontSize: 13, lineHeight: 19, fontStyle: 'italic', color: theme.color.inkSecondary }}>{item.text}</Text>
      </View>,
    );
  }
  // Tool activity — human label only (no raw command); shows a status dot.
  if (item.kind === 'tool') {
    const dot = item.toolStatus === 'error' ? theme.color.red : item.toolStatus === 'running' ? theme.color.blue : theme.color.green;
    return leftBubble(
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dot }} />
        <Icon name="terminal" size={13} color={theme.color.inkSecondary} />
        <Text numberOfLines={2} style={{ flex: 1, fontSize: 13, color: theme.color.ink }}>
          {item.name ? <Text style={{ fontWeight: '600' }}>{item.name}  </Text> : null}{item.text}
        </Text>
      </View>,
    );
  }
  // Reviewer verdict.
  if (item.kind === 'review') {
    const ok = item.verdict === 'approved';
    return leftBubble(
      <View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: item.text ? 4 : 0 }}>
          <Icon name={ok ? 'checkCircle' : 'alert'} size={13} color={ok ? theme.color.green : theme.color.orange} />
          <Text style={{ fontSize: 12, fontWeight: '700', color: ok ? theme.color.green : theme.color.orange }}>{ok ? 'Review passed' : 'Needs work'}</Text>
        </View>
        {item.text ? <Text style={{ fontSize: 13, lineHeight: 19, color: theme.color.ink }}>{item.text}</Text> : null}
      </View>,
      (ok ? theme.color.green : theme.color.orange) + '10',
    );
  }
  // Question the agent asked.
  if (item.kind === 'ask') {
    if (!item.text) return null;
    return leftBubble(
      <View style={{ flexDirection: 'row', gap: 7 }}>
        <Icon name="messageCircle" size={13} color={theme.color.blue} />
        <Text style={{ flex: 1, fontSize: 14, lineHeight: 20, color: theme.color.ink }}>{item.text}</Text>
      </View>,
      theme.color.blue + '10',
    );
  }
  return null;
}

/** The assistant side of a finished turn: engine + outcome (real transcript text slots in
 *  here once the host projects it). Left-aligned, muted — mirrors a chat reply. */
function AssistantBubble({ job }: { job: JobView }) {
  const { theme } = useTheme();
  const meta = jobStatusMeta(job.status, theme);
  const engine = job.engine ?? 'agent';
  const detail = job.phase && job.phase.toLowerCase() !== meta.label.toLowerCase() ? job.phase : null;
  return (
    <View style={{ alignSelf: 'flex-start', maxWidth: '86%', marginVertical: 3 }}>
      <View style={{ backgroundColor: theme.color.bgElevated, borderRadius: 18, borderBottomLeftRadius: 4, borderWidth: 0.5, borderColor: theme.color.separator, paddingHorizontal: 14, paddingVertical: 9, minWidth: 120 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: meta.color }} />
          <Text style={{ fontSize: 13, fontWeight: '600', color: theme.color.inkSecondary }}>{engine}</Text>
          <Text style={{ fontSize: 12, color: theme.color.inkTertiary }}>· {meta.label}</Text>
        </View>
        {detail ? <Text numberOfLines={3} style={{ fontSize: 13, lineHeight: 18, color: theme.color.ink, marginTop: 5 }}>{detail}</Text> : null}
      </View>
    </View>
  );
}
