import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, TextInput, KeyboardAvoidingView, Platform, ActivityIndicator, Modal, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useTheme } from '../theme';
import { Icon, type IconName } from '../Icon';
import { Mono } from '../ui';
import { api, type Job, type TranscriptItem } from '../api';
import { useLive } from '../useLive';
import { cacheGet, cacheSet } from '../storage';

/* Pick an icon for a tool by its name (best-effort; defaults to a terminal). */
function toolIcon(name: string): IconName {
  const n = name.toLowerCase();
  if (n.includes('search') || n.includes('grep') || n.includes('glob') || n.includes('web') || n.includes('fetch')) return 'search';
  if (n.includes('read') || n.includes('write') || n.includes('edit') || n.includes('file')) return 'file';
  return 'terminal';
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

function AgentBlocks({ job }: { job: Job }) {
  const { theme } = useTheme();
  const items = job.transcript ?? [];
  const live = job.status === 'running' || job.status === 'pending';

  const blocks: React.ReactNode[] = [];
  if (items.length) {
    items.forEach((it, i) => {
      if (it.kind === 'tool') {
        blocks.push(<ToolRow key={i} item={it} />);
      } else if (it.kind === 'ask') {
        blocks.push(
          <View key={i} style={{ borderRadius: 12, padding: 12, backgroundColor: theme.color.blue + '14', borderWidth: 0.5, borderColor: theme.color.blue + '40' }}>
            <Text style={{ fontSize: 12, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.blue, marginBottom: 5 }}>Question</Text>
            <Text style={{ fontSize: 15, lineHeight: 21, color: theme.color.ink }}>{it.ask || it.text}</Text>
          </View>,
        );
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

function Turn({ job }: { job: Job }) {
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
        <AgentBlocks job={job} />
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
  const scrollRef = useRef<ScrollView>(null);

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

  // Auto-scroll to the newest content.
  useEffect(() => { const t = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 60); return () => clearTimeout(t); }, [turns]);

  const send = () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setText('');
    api.sendChat({ projectId, text: body, sessionId })
      .then((res) => {
        if (!sessionId) { setSessionId(res.session.id); setTitle(res.session.title || body.slice(0, 40)); }
        // Optimistically show the new turn; live events fill in the reply.
        setTurns((prev) => [...prev, res.job]);
      })
      .catch(() => { setText(body); /* restore on failure */ })
      .finally(() => setSending(false));
  };

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
        <ScrollView ref={scrollRef} contentContainerStyle={{ padding: 16, paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
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
            turns.map((j) => <Turn key={j.id} job={j} />)
          )}
        </ScrollView>
      )}

      {/* composer */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingTop: 10, paddingBottom: insets.bottom + 10, borderTopWidth: 0.5, borderTopColor: theme.color.separator, backgroundColor: theme.color.bgGrouped }}>
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
