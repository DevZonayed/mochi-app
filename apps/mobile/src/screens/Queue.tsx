import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, ScrollView, Animated, StyleSheet, Modal, TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme';
import { Icon } from '../Icon';
import { api, type Schedule, type Project, type ChatSession } from '../api';
import { useLive } from '../useLive';

function MSwitch({ value, onValueChange }: { value: boolean; onValueChange: (v: boolean) => void }) {
  const { theme } = useTheme();
  const a = React.useRef(new Animated.Value(value ? 1 : 0)).current;
  React.useEffect(() => { Animated.timing(a, { toValue: value ? 1 : 0, duration: 200, useNativeDriver: false }).start(); }, [a, value]);
  const bg = a.interpolate({ inputRange: [0, 1], outputRange: [theme.color.fillSecondary, theme.color.green] });
  const left = a.interpolate({ inputRange: [0, 1], outputRange: [2, 22] });
  return (
    <Pressable onPress={() => onValueChange(!value)} hitSlop={6}>
      <Animated.View style={{ width: 51, height: 31, borderRadius: 16, backgroundColor: bg, justifyContent: 'center' }}>
        <Animated.View style={{ position: 'absolute', top: 2, left, width: 27, height: 27, borderRadius: 14, backgroundColor: '#fff' }} />
      </Animated.View>
    </Pressable>
  );
}

/** "in 2h 5m" / "in 3m" / "due" countdown to an absolute time. */
function until(ts: number, nowMs: number): string {
  const s = Math.round((ts - nowMs) / 1000);
  if (s <= 0) return 'due now';
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  return `in ${h}h ${m % 60}m`;
}

/** Human recurrence line for a recurring schedule row. */
function recurLabel(s: Schedule): string {
  if (s.everyMinutes && s.everyMinutes > 0) {
    const h = Math.floor(s.everyMinutes / 60), m = s.everyMinutes % 60;
    return `every ${h ? `${h}h` : ''}${m ? ` ${m}m` : ''}`.trim() + (s.catchUp ? ' · catch-up' : '');
  }
  return `${s.cadence} · ${s.time || ''}` + (s.catchUp ? ' · catch-up' : '');
}

/** Create / edit a recurring schedule from the phone. Daily-at-time or every-N-hours,
    optional project + chat target, a prompt, and a catch-up toggle. */
function ScheduleEditor({ open, initial, projects, onClose, onSaved }: { open: boolean; initial: Schedule | null; projects: Project[]; onClose: () => void; onSaved: () => void }) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [kind, setKind] = useState<'daily' | 'interval'>('daily');
  const [time, setTime] = useState('09:00');
  const [hours, setHours] = useState('3');
  const [prompt, setPrompt] = useState('');
  const [projectId, setProjectId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [catchUp, setCatchUp] = useState(true);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKind(initial?.everyMinutes ? 'interval' : 'daily');
    setTime(initial?.time || '09:00');
    setHours(initial?.everyMinutes ? String(Math.max(1, Math.round(initial.everyMinutes / 60))) : '3');
    setPrompt(initial?.prompt || '');
    setProjectId(initial?.projectId || '');
    setSessionId(initial?.sessionId || '');
    setCatchUp(!!initial?.catchUp);
  }, [open, initial]);

  useEffect(() => {
    if (!open || !projectId) { setSessions([]); return; }
    let alive = true;
    api.listSessions(projectId).then((r) => { if (alive) setSessions(r); }).catch(() => { if (alive) setSessions([]); });
    return () => { alive = false; };
  }, [open, projectId]);

  const hoursNum = Number(hours);
  const valid = prompt.trim().length > 0 && (kind === 'daily' ? /^\d{1,2}:\d{2}$/.test(time) : Number.isFinite(hoursNum) && hoursNum > 0);

  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const everyMinutes = kind === 'interval' ? Math.round(hoursNum * 60) : undefined;
    const common = { prompt: prompt.trim(), time: kind === 'daily' ? time : undefined, cadence: kind === 'daily' ? 'daily' : undefined, everyMinutes, catchUp, sessionId: sessionId || undefined };
    try {
      if (initial) await api.updateSchedule(initial.id, { title: prompt.trim().slice(0, 60), projectId: projectId || undefined, ...common });
      else await api.createSchedule({ title: prompt.trim().slice(0, 60), projectId: projectId || undefined, ...common });
      onSaved(); onClose();
    } catch { /* leave open so the user can retry */ } finally { setBusy(false); }
  };

  const fieldBg = { backgroundColor: theme.color.bgGrouped, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.color.separator };
  const chip = (active: boolean) => ({ flex: 1, paddingVertical: 9, borderRadius: 9, alignItems: 'center' as const, backgroundColor: active ? theme.color.blue : theme.color.fillSecondary });

  return (
    <Modal visible={open} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#0008', justifyContent: 'flex-end' }}>
        <View style={{ backgroundColor: theme.color.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingHorizontal: 18, paddingTop: 14, paddingBottom: insets.bottom + 16, maxHeight: '90%' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
            <Text style={{ flex: 1, fontSize: 20, fontWeight: '700', color: theme.color.ink }}>{initial ? 'Edit schedule' : 'New schedule'}</Text>
            <Pressable onPress={onClose} hitSlop={8}><Icon name="x" size={22} color={theme.color.inkSecondary} /></Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            {/* recurrence kind */}
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
              <Pressable onPress={() => setKind('daily')} style={chip(kind === 'daily')}><Text style={{ fontWeight: '600', color: kind === 'daily' ? '#fff' : theme.color.ink }}>Daily at</Text></Pressable>
              <Pressable onPress={() => setKind('interval')} style={chip(kind === 'interval')}><Text style={{ fontWeight: '600', color: kind === 'interval' ? '#fff' : theme.color.ink }}>Every N hours</Text></Pressable>
            </View>
            {kind === 'daily' ? (
              <TextInput value={time} onChangeText={setTime} placeholder="09:00" placeholderTextColor={theme.color.inkTertiary}
                style={{ ...fieldBg, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: theme.color.ink, marginBottom: 12 }} />
            ) : (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <Text style={{ color: theme.color.inkSecondary }}>Every</Text>
                <TextInput value={hours} onChangeText={setHours} keyboardType="number-pad"
                  style={{ ...fieldBg, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: theme.color.ink, width: 80 }} />
                <Text style={{ color: theme.color.inkSecondary }}>hours</Text>
              </View>
            )}
            {/* prompt */}
            <TextInput value={prompt} onChangeText={setPrompt} multiline placeholder="What should run each time? e.g. summarize my latest WhatsApp messages and send them to my private chat."
              placeholderTextColor={theme.color.inkTertiary}
              style={{ ...fieldBg, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: theme.color.ink, minHeight: 84, textAlignVertical: 'top', marginBottom: 12 }} />
            {/* project picker */}
            <Text style={{ fontSize: 12, fontWeight: '700', textTransform: 'uppercase', color: theme.color.inkTertiary, marginBottom: 6 }}>Project</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
              <Pressable onPress={() => { setProjectId(''); setSessionId(''); }} style={{ paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10, marginRight: 8, backgroundColor: !projectId ? theme.color.blue : theme.color.fillSecondary }}>
                <Text style={{ color: !projectId ? '#fff' : theme.color.ink, fontWeight: '600' }}>Workspace</Text>
              </Pressable>
              {projects.map((p) => (
                <Pressable key={p.id} onPress={() => { setProjectId(p.id); setSessionId(''); }} style={{ paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10, marginRight: 8, backgroundColor: projectId === p.id ? theme.color.blue : theme.color.fillSecondary }}>
                  <Text style={{ color: projectId === p.id ? '#fff' : theme.color.ink, fontWeight: '600' }}>{p.name}</Text>
                </Pressable>
              ))}
            </ScrollView>
            {projectId && sessions.length > 0 && (
              <>
                <Text style={{ fontSize: 12, fontWeight: '700', textTransform: 'uppercase', color: theme.color.inkTertiary, marginBottom: 6 }}>Run in chat (optional)</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
                  <Pressable onPress={() => setSessionId('')} style={{ paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10, marginRight: 8, backgroundColor: !sessionId ? theme.color.blue : theme.color.fillSecondary }}>
                    <Text style={{ color: !sessionId ? '#fff' : theme.color.ink, fontWeight: '600' }}>Any chat</Text>
                  </Pressable>
                  {sessions.map((se) => (
                    <Pressable key={se.id} onPress={() => setSessionId(se.id)} style={{ paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10, marginRight: 8, backgroundColor: sessionId === se.id ? theme.color.blue : theme.color.fillSecondary }}>
                      <Text numberOfLines={1} style={{ color: sessionId === se.id ? '#fff' : theme.color.ink, fontWeight: '600', maxWidth: 160 }}>{se.title}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </>
            )}
            {/* catch-up */}
            <Pressable onPress={() => setCatchUp((v) => !v)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 18 }}>
              <MSwitch value={catchUp} onValueChange={setCatchUp} />
              <Text style={{ flex: 1, color: theme.color.inkSecondary, fontSize: 13 }}>Catch up if missed — run it later the same day if the Mac was asleep.</Text>
            </Pressable>
          </ScrollView>
          <Pressable onPress={save} disabled={!valid || busy} style={{ paddingVertical: 14, borderRadius: 13, alignItems: 'center', backgroundColor: valid && !busy ? theme.color.blue : theme.color.fillSecondary }}>
            <Text style={{ fontWeight: '700', fontSize: 16, color: valid && !busy ? '#fff' : theme.color.inkTertiary }}>{initial ? 'Save changes' : 'Create schedule'}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

export function QueueScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();

  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [projects, setProjects] = useState<Record<string, Project>>({});
  const [projectList, setProjectList] = useState<Project[]>([]);
  const [now, setNow] = useState(Date.now());
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Schedule | null>(null);

  const load = useCallback(() => {
    api.listSchedules().then(setSchedules).catch(() => {});
    api.listProjects().then((ps) => { setProjects(Object.fromEntries(ps.map((p) => [p.id, p]))); setProjectList(ps); }).catch(() => {});
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useLive(['schedule', 'schedule-late'], load);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const openNew = () => { setEditing(null); setEditorOpen(true); };
  const openEdit = (s: Schedule) => { setEditing(s); setEditorOpen(true); };

  // Queued messages (one-shot fireAt) first, then recurring schedules.
  const queued = schedules.filter((s) => s.fireAt).sort((a, b) => (a.fireAt ?? 0) - (b.fireAt ?? 0));
  const recurring = schedules.filter((s) => !s.fireAt);

  const cancel = (id: string) => { setSchedules((s) => s.filter((x) => x.id !== id)); void api.deleteSchedule(id).catch(() => {}).finally(load); };
  const toggle = (id: string, enabled: boolean) => { void api.toggleSchedule(id, enabled).catch(() => {}).finally(load); };

  const Section = ({ title, items, oneShot }: { title: string; items: Schedule[]; oneShot: boolean }) => (
    items.length === 0 ? null : (
      <View style={{ marginBottom: 18 }}>
        <Text style={{ fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkSecondary, paddingHorizontal: 20, paddingBottom: 8 }}>{title}</Text>
        <View style={{ marginHorizontal: 16, backgroundColor: theme.color.bgElevated, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.color.separator, overflow: 'hidden' }}>
          {items.map((s, i) => {
            const proj = s.projectId ? projects[s.projectId] : undefined;
            return (
              <View key={s.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 15, borderBottomWidth: i < items.length - 1 ? StyleSheet.hairlineWidth : 0, borderBottomColor: theme.color.separator }}>
                <View style={{ width: 32, height: 32, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.blue + '1c' }}>
                  <Icon name={oneShot ? 'send' : 'clock'} size={16} color={theme.color.blue} />
                </View>
                <Pressable disabled={oneShot} onPress={() => openEdit(s)} style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 15, fontWeight: '600', color: theme.color.ink }}>{s.prompt || s.title}</Text>
                    {s.lastFireLate && <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, backgroundColor: theme.color.orange + '24' }}><Text style={{ fontSize: 10, fontWeight: '700', color: theme.color.orange }}>LATE</Text></View>}
                  </View>
                  <Text numberOfLines={1} style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 2 }}>
                    {proj ? `${proj.name} · ` : ''}{oneShot && s.fireAt ? until(s.fireAt, now) : recurLabel(s)}
                  </Text>
                </Pressable>
                {oneShot ? (
                  <Pressable onPress={() => cancel(s.id)} hitSlop={8} style={{ width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.fillSecondary }}>
                    <Icon name="x" size={15} color={theme.color.red} />
                  </Pressable>
                ) : (
                  <MSwitch value={s.enabled} onValueChange={(v) => toggle(s.id, v)} />
                )}
              </View>
            );
          })}
        </View>
      </View>
    )
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 4, paddingBottom: 30 }} showsVerticalScrollIndicator={false}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingBottom: 2 }}>
          <Pressable onPress={() => nav.goBack()} hitSlop={8}><Icon name="arrowLeft" size={22} color={theme.color.blue} /></Pressable>
          <View style={{ flex: 1 }} />
          <Pressable onPress={openNew} hitSlop={8} style={{ width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.blue }}>
            <Icon name="plus" size={20} color="#fff" />
          </Pressable>
        </View>
        <View style={{ paddingHorizontal: 20, paddingTop: 6, paddingBottom: 14 }}>
          <Text style={{ fontSize: 34, fontWeight: '700', letterSpacing: -0.7, color: theme.color.ink }}>Queue</Text>
          <Text style={{ fontSize: 14, color: theme.color.inkSecondary, marginTop: 3 }}>Messages and schedules waiting to run on your Mac.</Text>
        </View>

        {queued.length === 0 && recurring.length === 0 ? (
          <View style={{ alignItems: 'center', paddingVertical: 70, paddingHorizontal: 36 }}>
            <View style={{ width: 64, height: 64, borderRadius: 20, backgroundColor: theme.color.fillSecondary, alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
              <Icon name="clock" size={30} color={theme.color.inkTertiary} />
            </View>
            <Text style={{ fontSize: 16, fontWeight: '600', color: theme.color.ink, marginBottom: 6 }}>Nothing queued</Text>
            <Text style={{ fontSize: 14, lineHeight: 20, color: theme.color.inkSecondary, textAlign: 'center' }}>Tap + to create a recurring schedule, or schedule a one-off from a chat (the clock button). It appears here with a live countdown.</Text>
          </View>
        ) : (
          <>
            <Section title="Queued messages" items={queued} oneShot />
            <Section title="Recurring" items={recurring} oneShot={false} />
          </>
        )}
      </ScrollView>
      <ScheduleEditor open={editorOpen} initial={editing} projects={projectList} onClose={() => setEditorOpen(false)} onSaved={load} />
    </View>
  );
}
