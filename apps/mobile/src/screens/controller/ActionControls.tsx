/**
 * ActionControls — Phase 3C3 native controls for the SIX canonical actions, rendered inside
 * the accepted ShadowShell using the existing theme/parts. Every control renders ONLY when
 * the CURRENT verified grant permits its family AND the target is eligible; offline disables
 * it (no dead button). Each shows a truthful receipt (sent/working/done/failed/unknown) near
 * the target and a safe retry. No optimistic mutation, no raw ids/paths/command text.
 */
import React from 'react';
import { View, Text, TextInput, Modal, Pressable, KeyboardAvoidingView, Platform, ActivityIndicator, ScrollView, useWindowDimensions } from 'react-native';
import { useTheme } from '../../theme';
import { Icon } from '../../Icon';
import { PrimaryButton, GhostButton, StatusChip, useInsets, type StatusTone } from './parts';
import { grantAllows, type ActionFamilyKey } from '../../shadowActionCapabilities';
import { useActionController, useActionReceipt } from '../../shadowActionRuntime';
import type { ActionIntent } from '../../shadowActionController';
import type { ActionReceipt } from '../../shadowActionModel';
import type { JobView, ApprovalView, QuestionView, ProjectView, SessionView } from '../../shadowProjectionSelectors';
import type { ShadowCapability } from '@maestro/realtime/shadowCapabilities';

/** Whether a control's family may render at all (granted + not offline-hidden handled by caller). */
export function familyGranted(granted: readonly ShadowCapability[], key: ActionFamilyKey): boolean {
  return grantAllows(granted, key);
}

/** Ambient action environment (current granted set + online) — avoids prop-drilling
    through the shell's rows/details. Derived ONLY from the live ShadowUiState. */
export interface ActionEnv { granted: readonly ShadowCapability[]; online: boolean }
const ActionEnvContext = React.createContext<ActionEnv>({ granted: [], online: false });
export function ActionEnvProvider({ granted, online, children }: ActionEnv & { children: React.ReactNode }) {
  const value = React.useMemo(() => ({ granted, online }), [granted, online]);
  return <ActionEnvContext.Provider value={value}>{children}</ActionEnvContext.Provider>;
}
export function useActionEnv(): ActionEnv { return React.useContext(ActionEnvContext); }

const RECEIPT_TONE: Record<ActionReceipt['phase'], StatusTone> = {
  idle: 'neutral', preparing: 'pending', sent: 'pending', working: 'pending', done: 'online', failed: 'locked', unknown: 'pending',
};

/** Truthful receipt line for one action target + a safe retry. */
export function ActionReceiptRow({ intent, onRetry }: { intent: ActionIntent; onRetry?: () => void }) {
  const { theme } = useTheme();
  const receipt = useActionReceipt(intent);
  if (receipt.phase === 'idle') return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 }} accessibilityLiveRegion="polite">
      {receipt.phase === 'sent' || receipt.phase === 'working' || receipt.phase === 'preparing'
        ? <ActivityIndicator size="small" color={theme.color.inkTertiary} />
        : <StatusChip tone={RECEIPT_TONE[receipt.phase]} label={receipt.phase === 'done' ? 'Done' : receipt.phase === 'failed' ? 'Failed' : receipt.phase === 'unknown' ? 'Checking' : '…'} />}
      <Text style={{ flex: 1, fontSize: 13, color: theme.color.inkSecondary }}>{receipt.message}</Text>
      {receipt.retryable && onRetry ? (
        <Pressable onPress={onRetry} accessibilityRole="button" accessibilityLabel="Retry" hitSlop={8}>
          <Text style={{ fontSize: 13, fontWeight: '600', color: theme.color.blue }}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// ── shared modal shell ─────────────────────────────────────────────────────────
// A bottom sheet that stays safe at phone 390×844, with the OS keyboard open, and at OS
// fontScale 2: the content is bounded to ≤90% of the window and lives in a ScrollView
// (`keyboardShouldPersistTaps="handled"`) so EVERY control — including the footer Cancel +
// primary/destructive CTA — is reachable by scrolling; nothing is clipped off-screen. The
// keyboard is avoided (KeyboardAvoidingView) and the safe-area inset is padded at the bottom.
function Sheet({ visible, onClose, titleId, children }: { visible: boolean; onClose: () => void; titleId: string; children: React.ReactNode }) {
  const { theme } = useTheme();
  const insets = useInsets();
  const { height } = useWindowDimensions();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable style={{ flex: 1 }} accessibilityLabel="Dismiss" onPress={onClose} />
        <View accessibilityViewIsModal style={{ backgroundColor: theme.color.bgElevated, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderTopWidth: 0.5, borderColor: theme.color.separator, maxHeight: Math.round(height * 0.9) }}>
          <ScrollView
            aria-labelledby={titleId}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator
            style={{ flexGrow: 0 }}
            contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 24 }}
          >
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Field({ value, onChangeText, placeholder, label, multiline, max }: { value: string; onChangeText: (t: string) => void; placeholder: string; label: string; multiline?: boolean; max: number }) {
  const { theme } = useTheme();
  return (
    <TextInput
      value={value}
      onChangeText={(t) => onChangeText(t.slice(0, max))}
      placeholder={placeholder}
      placeholderTextColor={theme.color.inkTertiary}
      accessibilityLabel={label}
      multiline={multiline}
      style={{ minHeight: multiline ? 96 : 48, borderRadius: 12, paddingHorizontal: 14, paddingTop: multiline ? 12 : 0, backgroundColor: theme.color.bg, borderWidth: 0.5, borderColor: theme.color.separator, color: theme.color.ink, fontSize: 15, textAlignVertical: multiline ? 'top' : 'center' }}
    />
  );
}

// ── 1. Start a job ───────────────────────────────────────────────────────────
export function StartJobControl({ project, granted, online }: { project: ProjectView; granted: readonly ShadowCapability[]; online: boolean }) {
  const { theme } = useTheme();
  const ctrl = useActionController();
  const [open, setOpen] = React.useState(false);
  const [input, setInput] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [intent, setIntent] = React.useState<ActionIntent | null>(null);
  if (!familyGranted(granted, 'start-job')) return null;
  const send = async () => {
    if (busy || input.trim().length === 0) return;
    const it: ActionIntent = { family: 'start-job', projectId: project.id, input: input.trim(), title: title.trim() || undefined };
    setBusy(true); setIntent(it);
    const res = await ctrl.run(it);
    setBusy(false);
    if (res.ok) setOpen(false);
  };
  return (
    <View>
      <PrimaryButton title="Start a job" icon="plus" disabled={!online} label={`Start a job in ${project.name ?? 'this project'}`} onPress={() => setOpen(true)} />
      {intent ? <ActionReceiptRow intent={intent} onRetry={() => void ctrl.retry(intent)} /> : null}
      <Sheet visible={open} onClose={() => setOpen(false)} titleId="start-job-title">
        <Text nativeID="start-job-title" accessibilityRole="header" style={{ fontSize: 18, fontWeight: '700', color: theme.color.ink, marginBottom: 4 }}>Start a job</Text>
        <Text style={{ fontSize: 14, color: theme.color.inkSecondary, marginBottom: 14 }}>In {project.name ?? 'this project'}</Text>
        <Field value={input} onChangeText={setInput} placeholder="What should the agent do?" label="Job instructions" multiline max={16_000} />
        <View style={{ height: 10 }} />
        <Field value={title} onChangeText={setTitle} placeholder="Title (optional)" label="Job title" max={512} />
        <View style={{ height: 16 }} />
        <PrimaryButton title={busy ? 'Sending…' : 'Start job'} icon="arrowRight" disabled={busy || input.trim().length === 0} onPress={() => void send()} />
        <View style={{ height: 8 }} />
        <GhostButton title="Cancel" onPress={() => setOpen(false)} />
      </Sheet>
    </View>
  );
}

// ── generic destructive/consequential confirm ────────────────────────────────
function ConfirmSheet({ visible, title, body, confirmLabel, tone, busy, onCancel, onConfirm }: { visible: boolean; title: string; body: string; confirmLabel: string; tone?: 'danger' | 'default'; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const { theme } = useTheme();
  return (
    <Sheet visible={visible} onClose={onCancel} titleId="confirm-title">
      <Text nativeID="confirm-title" accessibilityRole="header" style={{ fontSize: 18, fontWeight: '700', color: theme.color.ink, marginBottom: 6 }}>{title}</Text>
      <Text style={{ fontSize: 14, lineHeight: 20, color: theme.color.inkSecondary, marginBottom: 16 }}>{body}</Text>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}><GhostButton title="Cancel" onPress={onCancel} /></View>
        <Pressable onPress={busy ? undefined : onConfirm} accessibilityRole="button" accessibilityLabel={confirmLabel}
          style={{ flex: 1, minHeight: 50, borderRadius: theme.radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: tone === 'danger' ? theme.color.red : theme.color.blue, opacity: busy ? 0.6 : 1 }}>
          <Text style={{ fontSize: 16, fontWeight: '600', color: '#fff' }}>{busy ? 'Working…' : confirmLabel}</Text>
        </Pressable>
      </View>
    </Sheet>
  );
}

// ── 2. Cancel a job ──────────────────────────────────────────────────────────
export function CancelJobControl({ job, granted, online }: { job: JobView; granted: readonly ShadowCapability[]; online: boolean }) {
  const { theme } = useTheme();
  const ctrl = useActionController();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const intent: ActionIntent = { family: 'cancel-job', jobId: job.id };
  if (!familyGranted(granted, 'cancel-job')) return null;
  const confirm = async () => { setBusy(true); const r = await ctrl.run(intent); setBusy(false); if (r.ok) setOpen(false); };
  return (
    <View>
      <Pressable onPress={() => setOpen(true)} disabled={!online} accessibilityRole="button" accessibilityLabel={`Cancel job ${job.title ?? ''}`}
        style={{ minHeight: 44, paddingHorizontal: 14, borderRadius: theme.radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.fillSecondary, opacity: online ? 1 : 0.5 }}>
        <Text style={{ fontSize: 14, fontWeight: '600', color: theme.color.red }}>Cancel job</Text>
      </Pressable>
      <ActionReceiptRow intent={intent} onRetry={() => void ctrl.retry(intent)} />
      <ConfirmSheet visible={open} title="Cancel this job?" tone="danger" busy={busy} confirmLabel="Cancel job"
        body={`This stops “${job.title ?? 'the job'}” on your Mac. This can’t be undone.`}
        onCancel={() => setOpen(false)} onConfirm={() => void confirm()} />
    </View>
  );
}

// ── 3. Approve / Deny an approval ────────────────────────────────────────────
export function ApprovalControl({ approval, granted, online }: { approval: ApprovalView; granted: readonly ShadowCapability[]; online: boolean }) {
  const { theme } = useTheme();
  const ctrl = useActionController();
  const [pending, setPending] = React.useState<'approve' | 'deny' | null>(null);
  const [busy, setBusy] = React.useState(false);
  const intent: ActionIntent | null = pending ? { family: 'respond-approval', approvalId: approval.id, decision: pending } : null;
  if (!familyGranted(granted, 'respond-approval')) return null;
  const submit = async () => { if (!pending) return; setBusy(true); const r = await ctrl.run({ family: 'respond-approval', approvalId: approval.id, decision: pending }); setBusy(false); if (r.ok) setPending(null); };
  return (
    <View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Pressable onPress={() => setPending('deny')} disabled={!online} accessibilityRole="button" accessibilityLabel={`Deny ${approval.title ?? 'approval'}`}
          style={{ flex: 1, minHeight: 44, borderRadius: theme.radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.fillSecondary, opacity: online ? 1 : 0.5 }}>
          <Text style={{ fontSize: 15, fontWeight: '600', color: theme.color.ink }}>Deny</Text>
        </Pressable>
        <Pressable onPress={() => setPending('approve')} disabled={!online} accessibilityRole="button" accessibilityLabel={`Approve ${approval.title ?? 'approval'}`}
          style={{ flex: 1, minHeight: 44, borderRadius: theme.radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.blue, opacity: online ? 1 : 0.5 }}>
          <Text style={{ fontSize: 15, fontWeight: '600', color: '#fff' }}>Approve</Text>
        </Pressable>
      </View>
      {intent ? <ActionReceiptRow intent={intent} onRetry={() => void ctrl.retry(intent)} /> : null}
      <ConfirmSheet visible={!!pending} title={pending === 'deny' ? 'Deny this request?' : 'Approve this request?'} tone={pending === 'deny' ? 'danger' : 'default'} busy={busy}
        confirmLabel={pending === 'deny' ? 'Deny' : 'Approve'}
        body={`${pending === 'deny' ? 'Deny' : 'Approve'} “${approval.title ?? 'this approval'}”${approval.tool ? ` (${approval.tool})` : ''} on your Mac.`}
        onCancel={() => setPending(null)} onConfirm={() => void submit()} />
    </View>
  );
}

// ── 4. Answer a question ─────────────────────────────────────────────────────
export function AnswerQuestionControl({ question, granted, online }: { question: QuestionView; granted: readonly ShadowCapability[]; online: boolean }) {
  const { theme } = useTheme();
  const ctrl = useActionController();
  const [answer, setAnswer] = React.useState('');
  const [intent, setIntent] = React.useState<ActionIntent | null>(null);
  const [busy, setBusy] = React.useState(false);
  // Answerable only when the projection carries the source job id the command needs.
  if (!familyGranted(granted, 'answer-question') || !question.sourceJobId) return null;
  const submit = async (text: string) => {
    if (busy || text.trim().length === 0) return;
    const it: ActionIntent = { family: 'answer-question', sessionId: question.sessionId, sourceJobId: question.sourceJobId!, answer: text.trim() };
    setBusy(true); setIntent(it); const r = await ctrl.run(it); setBusy(false); if (r.ok) setAnswer('');
  };
  return (
    <View style={{ marginTop: 8 }}>
      {question.choices && question.choices.length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          {question.choices.map((c) => (
            <Pressable key={c} onPress={() => void submit(c)} disabled={!online} accessibilityRole="button" accessibilityLabel={`Answer: ${c}`}
              style={{ paddingHorizontal: 14, minHeight: 40, borderRadius: theme.radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.fillSecondary, opacity: online ? 1 : 0.5 }}>
              <Text style={{ fontSize: 14, fontWeight: '600', color: theme.color.ink }}>{c}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
        <View style={{ flex: 1 }}><Field value={answer} onChangeText={setAnswer} placeholder="Type an answer…" label="Answer" max={8_000} /></View>
        <PrimaryButton title="Send" icon="send" disabled={!online || answer.trim().length === 0} onPress={() => void submit(answer)} />
      </View>
      {intent ? <ActionReceiptRow intent={intent} onRetry={() => void ctrl.retry(intent)} /> : null}
    </View>
  );
}

// ── 5 (6). Session composer: send message + autopilot toggle ─────────────────
export function SessionActionControls({ session, granted, online }: { session: SessionView; granted: readonly ShadowCapability[]; online: boolean }) {
  const { theme } = useTheme();
  const ctrl = useActionController();
  const [text, setText] = React.useState('');
  const [msgIntent, setMsgIntent] = React.useState<ActionIntent | null>(null);
  const [busy, setBusy] = React.useState(false);
  const canMessage = familyGranted(granted, 'send-message');
  const canAutopilot = familyGranted(granted, 'set-autopilot');
  const autopilotIntent: ActionIntent = { family: 'set-autopilot', sessionId: session.id, enabled: !(session.autopilot ?? false) };
  const send = async () => {
    if (busy || text.trim().length === 0) return;
    const it: ActionIntent = { family: 'send-message', sessionId: session.id, text: text.trim() };
    setBusy(true); setMsgIntent(it); const r = await ctrl.run(it); setBusy(false); if (r.ok) setText('');
  };
  if (!canMessage && !canAutopilot) return null;
  return (
    <View style={{ marginTop: 12, gap: 10 }}>
      {canAutopilot ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <Text style={{ fontSize: 15, color: theme.color.ink }}>Autopilot {session.autopilot ? 'on' : 'off'}</Text>
          <Pressable onPress={() => void ctrl.run(autopilotIntent)} disabled={!online} accessibilityRole="button" accessibilityLabel={`Turn autopilot ${session.autopilot ? 'off' : 'on'}`}
            style={{ minHeight: 40, paddingHorizontal: 16, borderRadius: theme.radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: session.autopilot ? theme.color.fillSecondary : theme.color.blue, opacity: online ? 1 : 0.5 }}>
            <Text style={{ fontSize: 14, fontWeight: '600', color: session.autopilot ? theme.color.ink : '#fff' }}>{session.autopilot ? 'Turn off' : 'Continue work'}</Text>
          </Pressable>
        </View>
      ) : null}
      {canAutopilot ? <ActionReceiptRow intent={autopilotIntent} onRetry={() => void ctrl.retry(autopilotIntent)} /> : null}
      {canMessage ? (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
          <View style={{ flex: 1 }}><Field value={text} onChangeText={setText} placeholder="Message this session…" label="Message" multiline max={16_000} /></View>
          <PrimaryButton title="Send" icon="send" disabled={!online || text.trim().length === 0} onPress={() => void send()} />
        </View>
      ) : null}
      {msgIntent ? <ActionReceiptRow intent={msgIntent} onRetry={() => void ctrl.retry(msgIntent)} /> : null}
    </View>
  );
}

/**
 * A single concise permissions/offline note (not repeated dead buttons). The informational body
 * text uses the primary `ink` token (NOT the disabled-control `inkTertiary`) so it clears WCAG AA
 * (4.5:1) against the real Overview background in BOTH themes: `ink` #000 on light `bg` #F2F2F7 =
 * 18.8:1, `ink` #FFF on dark `bg` #000 = 21:1 (measured composited RGB). Visual hierarchy is kept
 * by the 13pt footnote size + the decorative (secondary) lock/bolt icon. Truthful precedence is
 * preserved: an action-capable grant that goes offline shows the temporary offline copy first;
 * only an online zero-action grant shows the read-only copy.
 */
export function ActionsNote({ online, anyGranted }: { online: boolean; anyGranted: boolean }) {
  const { theme } = useTheme();
  if (online && anyGranted) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 }}>
      <Icon name={online ? 'lock' : 'bolt'} size={14} color={theme.color.inkTertiary} />
      <Text style={{ flex: 1, fontSize: 13, color: theme.color.ink }}>
        {!online ? 'Offline — reconnect to your Mac to run actions.' : 'This device has read-only access. Reconnect and request control to run actions.'}
      </Text>
    </View>
  );
}
