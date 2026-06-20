import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, TextInput, KeyboardAvoidingView, Platform, ActivityIndicator, Modal, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useTheme } from '../theme';
import { Icon, type IconName } from '../Icon';
import { Mono } from '../ui';
import { api, type Job, type TranscriptItem, type Effort, type ModelGroup } from '../api';
import { useLive } from '../useLive';
import { cacheGet, cacheSet } from '../storage';

/* Pick an icon for a tool by its name (best-effort; defaults to a terminal). */
function toolIcon(name: string): IconName {
  const n = name.toLowerCase();
  if (n.includes('search') || n.includes('grep') || n.includes('glob') || n.includes('web') || n.includes('fetch')) return 'search';
  if (n.includes('read') || n.includes('write') || n.includes('edit') || n.includes('file')) return 'file';
  return 'terminal';
}

/* ── Per-session effort dial (FAST → BALANCED → DEEP → MAX) ──────────────── */
const EFFORT_ORDER: Effort[] = ['fast', 'balanced', 'deep', 'max'];
function effortMeta(theme: ReturnType<typeof useTheme>['theme']): Record<Effort, { label: string; tint: string; bars: number }> {
  return {
    fast: { label: 'Fast', tint: theme.color.green, bars: 1 },
    balanced: { label: 'Balanced', tint: theme.color.blue, bars: 2 },
    deep: { label: 'Deep', tint: theme.color.orange, bars: 3 },
    max: { label: 'Max', tint: theme.color.red, bars: 4 },
  };
}

function EffortDial({ value, onChange }: { value: Effort; onChange: (e: Effort) => void }) {
  const { theme } = useTheme();
  const m = effortMeta(theme)[value];
  const cycle = () => onChange(EFFORT_ORDER[(EFFORT_ORDER.indexOf(value) + 1) % EFFORT_ORDER.length]);
  return (
    <Pressable
      onPress={cycle}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 7, height: 28, paddingHorizontal: 11, borderRadius: 14, backgroundColor: m.tint + '1c', borderWidth: 1, borderColor: m.tint + '55' }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 1.5, height: 12 }}>
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={{ width: 2.5, height: 4 + i * 2.6, borderRadius: 1, backgroundColor: i < m.bars ? m.tint : theme.color.inkTertiary, opacity: i < m.bars ? 1 : 0.35 }} />
        ))}
      </View>
      <Text style={{ fontSize: 11, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', color: m.tint }}>{m.label}</Text>
    </Pressable>
  );
}

/* ── Per-session model picker (Auto + the Mac's real model catalog) ──────── */
function ModelPicker({ groups, value, onChange }: { groups: ModelGroup[]; value: string; onChange: (key: string) => void }) {
  const { theme } = useTheme();
  const [open, setOpen] = useState(false);
  const all = groups.flatMap((g) => g.models);
  const label = value === 'auto' ? 'Auto' : (all.find((m) => m.key === value)?.label ?? 'Auto');
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 28, paddingHorizontal: 11, borderRadius: 14, backgroundColor: theme.color.fillSecondary, borderWidth: 1, borderColor: theme.color.separator }}
      >
        <Icon name="spark" size={14} color={value === 'auto' ? theme.color.inkSecondary : theme.color.ink} />
        <Text style={{ fontSize: 12, fontWeight: '600', color: theme.color.ink }}>{label}</Text>
        <Icon name="chevronDown" size={12} color={theme.color.inkTertiary} />
      </Pressable>
      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(10,12,24,0.45)', justifyContent: 'flex-end' }} onPress={() => setOpen(false)}>
          <Pressable onPress={() => {}} style={{ maxHeight: '75%', backgroundColor: theme.color.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingTop: 10, paddingBottom: 28 }}>
            <View style={{ alignItems: 'center', marginBottom: 8 }}>
              <View style={{ width: 36, height: 5, borderRadius: 3, backgroundColor: theme.color.separatorStrong }} />
            </View>
            <Text style={{ fontSize: 20, fontWeight: '700', color: theme.color.ink, paddingHorizontal: 20, marginBottom: 10 }}>Model for this chat</Text>
            <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 10 }} showsVerticalScrollIndicator={false}>
              {/* Auto */}
              <Pressable onPress={() => { onChange('auto'); setOpen(false); }} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 13, borderRadius: 12, marginBottom: 8, backgroundColor: value === 'auto' ? theme.color.blue + '1a' : theme.color.bgElevated, borderWidth: 1, borderColor: value === 'auto' ? theme.color.blue : theme.color.separator }}>
                <Icon name="spark" size={18} color={theme.color.inkSecondary} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: '600', color: theme.color.ink }}>Auto</Text>
                  <Text style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 1 }}>Routed per task (workspace default)</Text>
                </View>
                {value === 'auto' ? <Icon name="check" size={16} color={theme.color.blue} stroke={2.6} /> : null}
              </Pressable>
              {groups.map((g) => (
                <View key={g.provider} style={{ marginBottom: 8 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 6, paddingTop: 8, paddingBottom: 6 }}>
                    <Text style={{ fontSize: 12, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkSecondary }}>{g.label}</Text>
                    {!g.runnable ? <Text style={{ flex: 1, fontSize: 11, color: theme.color.inkTertiary }} numberOfLines={1}>· {g.reason || 'not available'}</Text> : null}
                  </View>
                  {g.models.map((m) => {
                    const on = m.key === value;
                    const disabled = !g.runnable || m.external;
                    return (
                      <Pressable
                        key={m.key}
                        disabled={disabled}
                        onPress={() => { onChange(m.key); setOpen(false); }}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 11, marginBottom: 6, opacity: disabled ? 0.45 : 1, backgroundColor: on ? theme.color.blue + '1a' : theme.color.bgElevated, borderWidth: 1, borderColor: on ? theme.color.blue : theme.color.separator }}
                      >
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                            <Text style={{ fontSize: 15, fontWeight: '600', color: theme.color.ink }}>{m.label}</Text>
                            {m.badge === 'NEW' ? <View style={{ paddingHorizontal: 6, height: 16, borderRadius: 8, backgroundColor: theme.color.purple + '28', justifyContent: 'center' }}><Text style={{ fontSize: 9, fontWeight: '700', color: theme.color.purple }}>NEW</Text></View> : null}
                            {m.external ? <Text style={{ fontSize: 11, color: theme.color.inkTertiary }}>↗</Text> : null}
                          </View>
                          {m.tierNote ? <Text style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 1 }}>{m.tierNote}</Text> : null}
                        </View>
                        {on ? <Icon name="check" size={16} color={theme.color.blue} stroke={2.6} /> : null}
                      </Pressable>
                    );
                  })}
                </View>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function ToolRow({ item }: { item: TranscriptItem }) {
  const { theme } = useTheme();
  const running = item.toolStatus === 'running';
  const error = item.toolStatus === 'error';
  const tint = error ? theme.color.red : running ? theme.color.purple : theme.color.inkSecondary;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 8, paddingHorizontal: 11, borderRadius: 10, backgroundColor: theme.color.fillTertiary, borderWidth: 0.5, borderColor: theme.color.separator }}>
      <View style={{ width: 22, height: 22, borderRadius: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: tint + '24' }}>
        <Icon name={toolIcon(item.name ?? '')} size={13} color={tint} />
      </View>
      <Text style={{ fontSize: 13, fontWeight: '600', color: theme.color.ink }}>{item.name || 'tool'}</Text>
      {item.text ? <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, fontFamily: theme.fontFamily.mono, color: theme.color.inkSecondary }}>{item.text}</Text> : <View style={{ flex: 1 }} />}
      {running ? <ActivityIndicator size="small" color={theme.color.purple} />
        : error ? <Icon name="x" size={13} color={theme.color.red} stroke={2.6} />
          : <Icon name="check" size={13} color={theme.color.green} stroke={2.6} />}
    </View>
  );
}

/* ── Agent question → a real, tappable card (not raw JSON) ───────────────── */
interface AskOption { label: string; description?: string }
interface AskQuestion { question: string; header?: string; multiSelect: boolean; options: AskOption[] }

function parseAsk(json?: string): AskQuestion[] {
  if (!json) return [];
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const list = Array.isArray(raw.questions) ? raw.questions : raw.question ? [raw] : [];
    return (list as Record<string, unknown>[])
      .map((q) => ({
        question: String(q.question ?? q.header ?? 'Pick an option'),
        header: typeof q.header === 'string' ? q.header : undefined,
        multiSelect: q.multiSelect === true || q.allowMultiple === true,
        options: (Array.isArray(q.options) ? q.options : []).map((o): AskOption =>
          typeof o === 'string' ? { label: o } : { label: String((o as AskOption).label ?? ''), description: (o as AskOption).description }),
      }))
      .filter((q) => q.options.length > 0);
  } catch {
    return [];
  }
}

function QuestionCard({ ask, onAnswer, answered }: { ask?: string; onAnswer: (text: string) => void; answered: boolean }) {
  const { theme } = useTheme();
  const questions = parseAsk(ask);
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  if (questions.length === 0) {
    // Couldn't parse structured options — show readable prompt text, never raw JSON.
    const looksJson = !!ask && ask.trim().startsWith('{');
    const prompt = ask && !looksJson ? ask : 'The agent asked a question — reply below to answer.';
    return (
      <View style={{ borderRadius: 14, padding: 13, borderWidth: 0.5, borderColor: theme.color.separator, backgroundColor: theme.color.bgGrouped, gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon name="command" size={13} color={theme.color.blue} />
          <Text style={{ fontSize: 12, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.blue }}>Agent is asking</Text>
        </View>
        <Text style={{ fontSize: 15, lineHeight: 21, color: theme.color.ink }}>{prompt}</Text>
      </View>
    );
  }
  const needsSubmit = questions.some((q) => q.multiSelect) || questions.length > 1;
  const accent = answered ? theme.color.green : theme.color.blue;

  const toggle = (qi: number, label: string, multi: boolean) => {
    setPicked((p) => {
      const cur = new Set(p[qi] ?? []);
      if (multi) { cur.has(label) ? cur.delete(label) : cur.add(label); } else { cur.clear(); cur.add(label); }
      return { ...p, [qi]: [...cur] };
    });
  };
  const onPick = (qi: number, q: AskQuestion, label: string) => {
    if (answered) return;
    if (q.multiSelect) toggle(qi, label, true);
    else { toggle(qi, label, false); if (!needsSubmit) onAnswer(label); }
  };
  const submit = () => {
    const parts = questions.map((q, qi) => { const sel = picked[qi] ?? []; return sel.length ? `${q.header ?? q.question}: ${sel.join(', ')}` : ''; }).filter(Boolean);
    if (parts.length) onAnswer(parts.join('\n'));
  };
  const anyPicked = Object.values(picked).some((s) => s.length > 0);

  return (
    <View style={{ borderRadius: 14, padding: 13, borderWidth: 0.5, borderColor: theme.color.separator, backgroundColor: theme.color.bgGrouped, opacity: answered ? 0.65 : 1, gap: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Icon name={answered ? 'check' : 'command'} size={13} color={accent} stroke={answered ? 2.6 : 2} />
        <Text style={{ fontSize: 12, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: accent }}>{answered ? 'Answered' : 'Agent is asking'}</Text>
      </View>
      {questions.map((q, qi) => {
        const sel = new Set(picked[qi] ?? []);
        const hasDesc = q.options.some((o) => o.description);
        return (
          <View key={qi} style={{ gap: 8 }}>
            <Text style={{ fontSize: 15, lineHeight: 21, fontWeight: '600', color: theme.color.ink }}>{q.question}</Text>
            {hasDesc ? (
              <View style={{ gap: 7 }}>
                {q.options.map((o, oi) => {
                  const on = sel.has(o.label);
                  return (
                    <Pressable key={oi} disabled={answered} onPress={() => onPick(qi, q, o.label)} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 11, borderRadius: 11, borderWidth: 1, borderColor: on ? theme.color.blue : theme.color.separator, backgroundColor: on ? theme.color.blue + '14' : theme.color.bgElevated }}>
                      <View style={{ width: 18, height: 18, borderRadius: q.multiSelect ? 5 : 9, marginTop: 1, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: on ? theme.color.blue : theme.color.separatorStrong, backgroundColor: on ? theme.color.blue : 'transparent' }}>
                        {on ? <Icon name="check" size={11} color="#fff" stroke={3} /> : null}
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ fontSize: 14, fontWeight: '600', color: theme.color.ink }}>{o.label}</Text>
                        {o.description ? <Text style={{ fontSize: 12, lineHeight: 17, color: theme.color.inkSecondary, marginTop: 2 }}>{o.description}</Text> : null}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            ) : (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
                {q.options.map((o, oi) => {
                  const on = sel.has(o.label);
                  return (
                    <Pressable key={oi} disabled={answered} onPress={() => onPick(qi, q, o.label)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 14, borderRadius: 17, borderWidth: 1, borderColor: on ? theme.color.blue : theme.color.separatorStrong, backgroundColor: on ? theme.color.blue : theme.color.bgElevated }}>
                      {q.multiSelect && on ? <Icon name="check" size={12} color="#fff" stroke={3} /> : null}
                      <Text style={{ fontSize: 14, fontWeight: '600', color: on ? '#fff' : theme.color.ink }}>{o.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>
        );
      })}
      {answered ? (
        <Text style={{ fontSize: 12, color: theme.color.inkTertiary }}>Send another message to change your answer.</Text>
      ) : needsSubmit ? (
        <Pressable onPress={submit} disabled={!anyPicked} style={{ alignSelf: 'flex-start', height: 38, paddingHorizontal: 18, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: anyPicked ? theme.color.blue : theme.color.fillSecondary }}>
          <Text style={{ fontSize: 14, fontWeight: '600', color: anyPicked ? '#fff' : theme.color.inkTertiary }}>Send answer</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function AgentBlocks({ job, onAnswer, answered }: { job: Job; onAnswer: (text: string) => void; answered: boolean }) {
  const { theme } = useTheme();
  const items = job.transcript ?? [];
  const live = job.status === 'running' || job.status === 'pending';

  const blocks: React.ReactNode[] = [];
  if (items.length) {
    items.forEach((it, i) => {
      if (it.kind === 'tool') {
        blocks.push(<ToolRow key={i} item={it} />);
      } else if (it.kind === 'ask') {
        blocks.push(<QuestionCard key={i} ask={it.ask || it.text} onAnswer={onAnswer} answered={answered} />);
      } else if (it.kind === 'review') {
        const ok = it.verdict === 'approved';
        blocks.push(
          <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, padding: 12, backgroundColor: (ok ? theme.color.green : theme.color.orange) + '14', borderWidth: 0.5, borderColor: (ok ? theme.color.green : theme.color.orange) + '40' }}>
            <Icon name="shield" size={15} color={ok ? theme.color.green : theme.color.orange} />
            <Text style={{ flex: 1, fontSize: 14, lineHeight: 19, color: theme.color.ink }}>{it.text || (ok ? 'Reviewer approved' : 'Reviewer asked for changes')}{it.resolved ? ' · resolved' : ''}</Text>
          </View>,
        );
      } else if (it.kind === 'image') {
        blocks.push(
          <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, padding: 12, backgroundColor: theme.color.fillTertiary }}>
            <Icon name="image" size={16} color={theme.color.purple} />
            <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, color: theme.color.inkSecondary }}>{it.alt || it.text || 'Generated image'}</Text>
          </View>,
        );
      } else if (it.text && it.text.trim()) {
        blocks.push(<Text key={i} style={{ fontSize: 16, lineHeight: 24, color: theme.color.ink }}>{it.text.trim()}</Text>);
      }
    });
  } else if (job.error) {
    blocks.push(<Text key="err" style={{ fontSize: 15, lineHeight: 22, color: theme.color.red }}>{job.error}</Text>);
  } else if (job.output && job.output.trim()) {
    blocks.push(<Text key="out" style={{ fontSize: 16, lineHeight: 24, color: theme.color.ink }}>{job.output.trim()}</Text>);
  } else if (live) {
    blocks.push(
      <View key="working" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <ActivityIndicator size="small" color={theme.color.purple} />
        <Text style={{ fontSize: 15, color: theme.color.inkSecondary }}>{job.phase || 'Working…'}</Text>
      </View>,
    );
  } else {
    blocks.push(<Text key="empty" style={{ fontSize: 14, color: theme.color.inkTertiary }}>No reply recorded.</Text>);
  }

  return <View style={{ gap: 10 }}>{blocks}</View>;
}

function Turn({ job, onAnswer, answered }: { job: Job; onAnswer: (text: string) => void; answered: boolean }) {
  const { theme } = useTheme();
  return (
    <View style={{ gap: 12, marginBottom: 20 }}>
      {/* user message */}
      {job.input ? (
        <View style={{ alignSelf: 'flex-end', maxWidth: '88%', backgroundColor: theme.color.blue, borderRadius: 18, borderBottomRightRadius: 5, paddingVertical: 10, paddingHorizontal: 14 }}>
          <Text style={{ fontSize: 16, lineHeight: 22, color: '#fff' }}>{job.input}</Text>
        </View>
      ) : null}
      {/* agent reply */}
      <View style={{ alignSelf: 'flex-start', maxWidth: '94%' }}>
        <AgentBlocks job={job} onAnswer={onAnswer} answered={answered} />
        {job.status === 'done' || job.status === 'failed' ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <Mono style={{ fontSize: 11, color: theme.color.inkTertiary }}>${job.cost.toFixed(2)}</Mono>
            {job.tokens ? <Mono style={{ fontSize: 11, color: theme.color.inkTertiary }}>· {job.tokens.toLocaleString()} tok</Mono> : null}
            {job.model ? <Text style={{ fontSize: 11, color: theme.color.inkTertiary }}>· {job.model}</Text> : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

export function SessionChatScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const projectId: string = route.params?.projectId;

  const initialSid: string | undefined = route.params?.sessionId;
  const [sessionId, setSessionId] = useState<string | undefined>(initialSid);
  const [title, setTitle] = useState<string>(route.params?.title ?? 'New chat');
  // Seed the thread from cache for an instant open; refresh from the relay below.
  const [turns, setTurns] = useState<Job[]>(() => (initialSid ? cacheGet<Job[]>(`turns.${initialSid}`, []) : []));
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(() => !!initialSid && cacheGet<Job[]>(`turns.${initialSid}`, []).length === 0);
  const [schedOpen, setSchedOpen] = useState(false);
  // Per-session effort + model — remembered for the chat, sent with every message.
  const [effort, setEffort] = useState<Effort>(() => (initialSid ? cacheGet<Effort>(`effort.${initialSid}`, 'balanced') : 'balanced'));
  const [modelKey, setModelKey] = useState<string>(() => (initialSid ? cacheGet<string>(`model.${initialSid}`, 'auto') : 'auto'));
  const [models, setModels] = useState<ModelGroup[]>(() => cacheGet('models', []));
  const scrollRef = useRef<ScrollView>(null);
  /* User-intent scroll tracking. The previous implementation snapped back to
     the bottom every time `turns` updated — which fires constantly during a
     stream, so swiping up to read older content immediately got yanked back
     down. Now: track whether the user is near the bottom (within NEAR_BOTTOM_PX
     of the last frame) and ONLY auto-scroll when they are.

     - `atBottomRef` is a ref (not state) because we read it inside the
       scroll-trigger effect without wanting that effect to re-run when it
       flips. The pill render uses `pendingNew` state so it re-renders.
     - When the user pulls up, a "↓ new messages" pill appears; tapping it
       jumps to the bottom and re-enables auto-scroll. */
  const NEAR_BOTTOM_PX = 80;
  const atBottomRef = useRef(true);
  const [pendingNew, setPendingNew] = useState(false);
  const jumpToBottom = useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
    atBottomRef.current = true;
    setPendingNew(false);
  }, []);
  const onScroll = useCallback((e: import('react-native').NativeSyntheticEvent<import('react-native').NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
    const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    const now = distanceFromBottom <= NEAR_BOTTOM_PX;
    if (now !== atBottomRef.current) atBottomRef.current = now;
    if (now && pendingNew) setPendingNew(false);
  }, [pendingNew]);

  const changeEffort = (e: Effort) => { setEffort(e); if (sessionId) cacheSet(`effort.${sessionId}`, e); };
  const changeModel = (key: string) => { setModelKey(key); if (sessionId) cacheSet(`model.${sessionId}`, key); };

  // Load the Mac's model catalog (cache-then-network) for the picker.
  useEffect(() => { api.listModels().then((g) => { setModels(g); cacheSet('models', g); }).catch(() => {}); }, []);

  const load = useCallback(() => {
    if (!sessionId) { setLoading(false); return; }
    api.listJobs(projectId, sessionId)
      .then((js) => {
        const sorted = js.slice().sort((a, b) => a.createdAt - b.createdAt);
        setTurns(sorted);
        cacheSet(`turns.${sessionId}`, sorted);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectId, sessionId]);

  useEffect(() => { load(); }, [load]);

  // Real-time: any job/session event touching THIS session refreshes the thread.
  useLive(['job', 'session'], (name, data) => {
    const d = data as { sessionId?: string; id?: string } | null;
    if (name === 'job' && sessionId && d?.sessionId === sessionId) load();
    else if (name === 'session' && sessionId && d?.id === sessionId) load();
  });

  const liveTurn = turns.some((j) => j.status === 'running' || j.status === 'pending');

  // Auto-scroll to the newest content — ONLY when the user is already near the
  // bottom. If they've intentionally pulled up to read older messages, leave
  // their position alone and surface a "↓ new messages" pill instead so they
  // can opt back in when they're ready. (Previously this snapped them down on
  // every render — the "won't let me read" bug.)
  useEffect(() => {
    if (atBottomRef.current) {
      const t = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 60);
      return () => clearTimeout(t);
    }
    // Off-bottom + new turn content arrived → flag the pill.
    setPendingNew(true);
    return undefined;
  }, [turns]);

  // Core send — used by the composer AND by answering a question's option.
  const dispatchChat = useCallback((body: string) => {
    setSending(true);
    return api.sendChat({ projectId, text: body, sessionId, effort, ...(modelKey !== 'auto' ? { modelKey } : {}) })
      .then((res) => {
        if (!sessionId) {
          setSessionId(res.session.id); setTitle(res.session.title || body.slice(0, 40));
          cacheSet(`effort.${res.session.id}`, effort); cacheSet(`model.${res.session.id}`, modelKey);
        }
        // Optimistically show the new turn; live events fill in the reply.
        setTurns((prev) => [...prev, res.job]);
      })
      .finally(() => setSending(false));
  }, [projectId, sessionId, effort, modelKey]);

  const send = () => {
    const body = text.trim();
    if (!body || sending) return;
    setText('');
    dispatchChat(body).catch(() => setText(body)); // restore on failure
  };

  // Answer an agent question by sending the chosen option(s) as a turn.
  const answer = (body: string) => { if (!sending && body.trim()) void dispatchChat(body).catch(() => {}); };

  // Queue the typed message to deliver into this chat at a future time.
  const scheduleAt = (ms: number, label: string) => {
    const body = text.trim();
    if (!body || !sessionId) return;
    setSchedOpen(false);
    setText('');
    api.createSchedule({ projectId, sessionId, fireAt: Date.now() + ms, prompt: body, title: body.slice(0, 48) })
      .then(() => Alert.alert('Queued', `“${body.slice(0, 40)}” will send ${label.toLowerCase()}.`))
      .catch(() => { setText(body); Alert.alert('Could not queue', 'Your Mac may be offline.'); });
  };

  const openScheduler = () => {
    if (!text.trim()) { Alert.alert('Type a message', 'Write the message you want to queue first.'); return; }
    if (!sessionId) { Alert.alert('Start the chat first', 'Send one message so the chat exists, then you can queue follow-ups.'); return; }
    setSchedOpen(true);
  };

  const PRESETS: { label: string; ms: number }[] = [
    { label: 'In 15 minutes', ms: 15 * 60_000 },
    { label: 'In 1 hour', ms: 60 * 60_000 },
    { label: 'In 3 hours', ms: 3 * 60 * 60_000 },
    { label: 'In 8 hours', ms: 8 * 60 * 60_000 },
    { label: 'In 24 hours', ms: 24 * 60 * 60_000 },
  ];

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: theme.color.bg }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={0}>
      {/* header */}
      <View style={{ paddingTop: insets.top + 4, paddingBottom: 10, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: 0.5, borderBottomColor: theme.color.separator }}>
        <Pressable onPress={() => nav.goBack()} hitSlop={8}>
          <Icon name="arrowLeft" size={22} color={theme.color.blue} />
        </Pressable>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: '600', color: theme.color.ink }}>{title}</Text>
          {liveTurn ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: theme.color.purple }} />
              <Text style={{ fontSize: 12, fontWeight: '500', color: theme.color.purple }}>Working…</Text>
            </View>
          ) : null}
        </View>
        <Pressable onPress={() => nav.navigate('Queue')} hitSlop={8} style={{ width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="clock" size={20} color={theme.color.inkSecondary} />
        </Pressable>
      </View>

      {/* transcript */}
      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={theme.color.blue} /></View>
      ) : (
        <View style={{ flex: 1 }}>
          <ScrollView
            ref={scrollRef}
            contentContainerStyle={{ padding: 16, paddingBottom: 24 }}
            showsVerticalScrollIndicator={false}
            onScroll={onScroll}
            // 16ms ≈ 60Hz — frequent enough to catch the swipe instantly,
            // cheap enough to never block the render thread.
            scrollEventThrottle={16}
          >
            {turns.length === 0 ? (
              <View style={{ alignItems: 'center', paddingVertical: 70, paddingHorizontal: 30, gap: 12 }}>
                <View style={{ width: 60, height: 60, borderRadius: 18, backgroundColor: theme.color.fillSecondary, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="chat" size={28} color={theme.color.inkTertiary} />
                </View>
                <Text style={{ fontSize: 15, lineHeight: 21, color: theme.color.inkSecondary, textAlign: 'center' }}>
                  Send a message to start. It runs on your Mac in this project, and the reply streams back here live.
                </Text>
              </View>
            ) : (
              turns.map((j, i) => <Turn key={j.id} job={j} onAnswer={answer} answered={i < turns.length - 1} />)
            )}
          </ScrollView>
          {/* "↓ new messages" pill — only when the user has pulled away from
              the bottom AND a new turn arrived underneath them. Tapping it
              jumps to the bottom AND re-enables auto-scroll going forward. */}
          {pendingNew ? (
            <Pressable
              onPress={jumpToBottom}
              accessibilityRole="button"
              accessibilityLabel="Jump to latest message"
              style={({ pressed }) => ({
                position: 'absolute',
                bottom: 16,
                alignSelf: 'center',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingHorizontal: 14,
                paddingVertical: 8,
                borderRadius: theme.radius.pill,
                backgroundColor: theme.color.blue,
                shadowColor: '#000',
                shadowOpacity: 0.18,
                shadowRadius: 8,
                shadowOffset: { width: 0, height: 4 },
                elevation: 4,
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Icon name="chevronDown" size={15} color="#fff" stroke={2.6} />
              <Text style={{ fontSize: 13, fontWeight: '600', color: '#fff' }}>New messages</Text>
            </Pressable>
          ) : null}
        </View>
      )}

      {/* composer */}
      <View style={{ paddingBottom: insets.bottom + 10, borderTopWidth: 0.5, borderTopColor: theme.color.separator, backgroundColor: theme.color.bgGrouped }}>
        {/* effort + model strip — applies to this chat's messages */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingTop: 9 }}>
          <EffortDial value={effort} onChange={changeEffort} />
          <ModelPicker groups={models} value={modelKey} onChange={changeModel} />
          <View style={{ flex: 1 }} />
        </View>
        {/* input row */}
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingTop: 8 }}>
          <Pressable onPress={openScheduler} style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.fillSecondary }}>
            <Icon name="clock" size={19} color={theme.color.inkSecondary} />
          </Pressable>
          <View style={{ flex: 1, minHeight: 44, maxHeight: 130, borderRadius: 22, backgroundColor: theme.color.bgElevated, borderWidth: 0.5, borderColor: theme.color.separator, paddingHorizontal: 16, justifyContent: 'center' }}>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="Message the agent…"
              placeholderTextColor={theme.color.inkTertiary}
              multiline
              style={{ fontSize: 16, lineHeight: 21, color: theme.color.ink, paddingVertical: 11 }}
            />
          </View>
          <Pressable
            onPress={send}
            disabled={!text.trim() || sending}
            style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: text.trim() && !sending ? theme.color.blue : theme.color.fillSecondary }}
          >
            {sending ? <ActivityIndicator size="small" color="#fff" /> : <Icon name="send" size={19} color={text.trim() ? '#fff' : theme.color.inkTertiary} />}
          </Pressable>
        </View>
      </View>

      {/* schedule (queue a message) */}
      <Modal visible={schedOpen} transparent animationType="slide" onRequestClose={() => setSchedOpen(false)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(10,12,24,0.45)', justifyContent: 'flex-end' }} onPress={() => setSchedOpen(false)}>
          <Pressable onPress={() => {}} style={{ backgroundColor: theme.color.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, paddingBottom: insets.bottom + 28 }}>
            <View style={{ alignItems: 'center', marginBottom: 14 }}>
              <View style={{ width: 36, height: 5, borderRadius: 3, backgroundColor: theme.color.separatorStrong }} />
            </View>
            <Text style={{ fontSize: 20, fontWeight: '700', color: theme.color.ink, marginBottom: 4 }}>Queue this message</Text>
            <Text numberOfLines={2} style={{ fontSize: 14, lineHeight: 20, color: theme.color.inkSecondary, marginBottom: 16 }}>
              “{text.trim()}” will be sent into this chat on your Mac.
            </Text>
            <View style={{ gap: 8 }}>
              {PRESETS.map((p) => (
                <Pressable key={p.label} onPress={() => scheduleAt(p.ms, p.label)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, height: 52, paddingHorizontal: 16, borderRadius: 14, backgroundColor: theme.color.fillTertiary, borderWidth: 0.5, borderColor: theme.color.separator }}>
                  <Icon name="clock" size={18} color={theme.color.blue} />
                  <Text style={{ flex: 1, fontSize: 16, fontWeight: '600', color: theme.color.ink }}>{p.label}</Text>
                  <Icon name="chevronRight" size={16} color={theme.color.inkTertiary} />
                </Pressable>
              ))}
            </View>
            <Pressable onPress={() => setSchedOpen(false)} style={{ height: 50, borderRadius: theme.radius.pill, backgroundColor: theme.color.fillSecondary, alignItems: 'center', justifyContent: 'center', marginTop: 16 }}>
              <Text style={{ fontSize: 16, fontWeight: '600', color: theme.color.ink }}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}
