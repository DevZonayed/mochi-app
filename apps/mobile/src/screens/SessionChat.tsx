import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, TextInput, KeyboardAvoidingView, Platform, ActivityIndicator, Modal, Alert, Image } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { useTheme } from '../theme';
import { Icon, type IconName } from '../Icon';
import { Mono } from '../ui';
import { api, type Job, type TranscriptItem, type Effort, type ModelGroup } from '../api';
import { cacheGet, cacheSet } from '../storage';
import { pullSync, useSyncStore } from '../syncStore';

/* One inline composer chip — either an image (vision) or a file (text inlined
   into the prompt on the Mac, or binary saved as an asset). Bytes ride along as
   base64; the Mac's `sendChat` ingestor (apps/desktop/electron/localApi.ts:470)
   slots them into the job and clears them. Capped to keep payload sane. */
type AttachChip = {
  id: string;
  kind: 'image' | 'file';
  name: string;
  mime: string;
  dataB64: string;
  previewUri?: string; // local URI used by the chip thumbnail before upload
};

/** Cross-platform "URI → base64" — DocumentPicker doesn't return the bytes, so
    we fetch the local file URI and stream it through FileReader. Works in both
    Expo Go and standalone builds without pulling in expo-file-system. */
async function uriToBase64(uri: string): Promise<string> {
  const res = await fetch(uri);
  const blob = await res.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

/* Pick an icon for a tool by its name (best-effort; defaults to a terminal). */

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

const isSkillTool = (name?: string): boolean => (name ?? '').toLowerCase() === 'skill';
const prettySkillName = (raw: string): string => { const tail = (raw.split(':').pop() ?? raw).replace(/[-_]/g, ' ').trim(); return tail ? tail.replace(/\b\w/g, (c) => c.toUpperCase()) : raw; };

// Extended thinking → calm dimmed prose under a purple header, tap to expand/collapse.
function ThinkingRow({ item }: { item: TranscriptItem }) {
  const { theme } = useTheme();
  const [open, setOpen] = useState(false);
  const text = (item.text || '').trim();
  if (!text) return null;
  const preview = text.replace(/\s+/g, ' ').slice(0, 80);
  return (
    <View>
      <Pressable onPress={() => setOpen((o) => !o)} style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
        <View style={{ width: 18, height: 18, borderRadius: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.purple + '24' }}>
          <Icon name="spark" size={11} color={theme.color.purple} />
        </View>
        <Text style={{ fontSize: 11, fontWeight: '600', letterSpacing: 0.6, textTransform: 'uppercase', color: theme.color.purple }}>Thinking</Text>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} color={theme.color.inkTertiary} />
        {!open && <Text numberOfLines={1} style={{ flex: 1, fontSize: 11, color: theme.color.inkTertiary }}>{preview}…</Text>}
      </Pressable>
      {open && (
        <View style={{ marginTop: 6, marginLeft: 8, paddingLeft: 12, borderLeftWidth: 1.5, borderLeftColor: theme.color.purple + '3d' }}>
          <Text style={{ fontSize: 13, lineHeight: 21, color: theme.color.inkSecondary }}>{text}</Text>
        </View>
      )}
    </View>
  );
}

// Short friendly identity for a tool — verb + glyph (+ file flag), mirrors desktop toolDisplay.
function toolDisplay(name: string): { short: string; icon: IconName; tint: 'blue' | 'teal' | 'indigo' | 'purple' | 'ink'; file?: boolean; mono?: boolean } {
  const raw = (name || '').replace(/^mcp__[^_]+__/, '');
  const n = raw.toLowerCase();
  if (/multiedit|multi_edit|^edit|apply_patch|str_replace/.test(n)) return { short: 'Edit', icon: 'file', tint: 'teal', file: true };
  if (/^write|create_file|^notebook/.test(n)) return { short: 'Write', icon: 'file', tint: 'teal', file: true };
  if (/^read|^view|^cat|open_file/.test(n)) return { short: 'Read', icon: 'file', tint: 'teal', file: true };
  if (/grep|^search$|ripgrep/.test(n)) return { short: 'Search', icon: 'search', tint: 'teal' };
  if (/glob|^ls$|list_dir|list_files|^find/.test(n)) return { short: 'Find', icon: 'search', tint: 'teal' };
  if (/websearch|web_search/.test(n)) return { short: 'Web search', icon: 'telescope', tint: 'indigo' };
  if (/webfetch|web_fetch|^fetch|^http|browser|navigate/.test(n)) return { short: 'Fetch', icon: 'telescope', tint: 'indigo' };
  if (/image|photo|picture|generate_image/.test(n)) return { short: 'Image', icon: 'image', tint: 'purple' };
  if (/todo/.test(n)) return { short: 'Plan', icon: 'checkCircle', tint: 'blue' };
  if (/task|subagent|^agent|dispatch/.test(n)) return { short: 'Agent', icon: 'spark', tint: 'purple' };
  if (/bash|shell|^run|exec|terminal|command/.test(n)) return { short: 'Run', icon: 'terminal', tint: 'blue', mono: true };
  const pretty = raw.replace(/[_-]+/g, ' ').trim();
  return { short: pretty ? pretty.charAt(0).toUpperCase() + pretty.slice(1) : 'Tool', icon: 'command', tint: 'ink' };
}
const baseName = (p: string): string => (p.split(/[?#]/)[0].split(/[\\/]/).filter(Boolean).pop() || p).trim();

function ToolRow({ item }: { item: TranscriptItem }) {
  const { theme } = useTheme();
  const running = item.toolStatus === 'running';
  const error = item.toolStatus === 'error';
  const isSkill = isSkillTool(item.name);
  const d = toolDisplay(item.name ?? '');
  const short = isSkill ? 'Skill' : d.short;
  const glyph = isSkill ? theme.color.purple : error ? theme.color.red : d.tint === 'ink' ? theme.color.inkSecondary : theme.color[d.tint];
  const showFile = !!d.file && !!item.text && !isSkill;
  const hasCmd = !!item.cmd && !showFile && !isSkill;
  const detail = isSkill ? prettySkillName(item.text) : (showFile ? baseName(item.text) : item.text);
  const detailMono = showFile || (!isSkill && !!d.mono && !hasCmd); // file basename or a raw shell command → mono
  const trailing = running ? <ActivityIndicator size="small" color={theme.color.purple} />
    : error ? <Icon name="x" size={13} color={theme.color.red} stroke={2.6} />
      : <Icon name="check" size={13} color={theme.color.green} stroke={2.6} />;
  return (
    <View style={{ flexDirection: 'row', alignItems: hasCmd ? 'flex-start' : 'center', gap: 9, paddingVertical: 5, paddingHorizontal: 7 }}>
      <View style={{ width: 18, alignItems: 'center', justifyContent: 'center', marginTop: hasCmd ? 1 : 0 }}>
        <Icon name={isSkill ? 'spark' : d.icon} size={15} color={glyph} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <Text style={{ fontSize: 13, fontWeight: '600', color: error ? theme.color.red : theme.color.ink }}>{short}</Text>
          {detail ? <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, fontFamily: detailMono ? theme.fontFamily.mono : undefined, color: isSkill ? theme.color.ink : theme.color.inkSecondary }}>{detail}</Text> : null}
        </View>
        {hasCmd ? <Text numberOfLines={1} style={{ alignSelf: 'flex-start', maxWidth: '100%', fontSize: 11, fontFamily: theme.fontFamily.mono, color: theme.color.inkSecondary, backgroundColor: theme.color.fillTertiary, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 1, overflow: 'hidden' }}>{item.cmd}</Text> : null}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: hasCmd ? 2 : 0 }}>
        {item.durMs != null && !running && !error ? <Text style={{ fontSize: 11, fontFamily: theme.fontFamily.mono, color: theme.color.inkTertiary }}>{item.durMs < 1000 ? `${item.durMs}ms` : `${(item.durMs / 1000).toFixed(1)}s`}</Text> : null}
        {trailing}
      </View>
    </View>
  );
}

// A run of consecutive tool steps — a calm flat list (no card framing).
function ToolGroupCard({ items }: { items: TranscriptItem[] }) {
  return (
    <View style={{ gap: 1 }}>
      {items.map((it, i) => <ToolRow key={i} item={it} />)}
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

/* Compact "tool work" summary pill that the user can tap to expand the hidden
   tool/text blocks. Mirrors the desktop's WorkBar (ProjectDetail.tsx) so the
   collapse signal matches: turn is done, a final text/result exists, prior work
   is non-empty, no pending question or image (those always stay expanded). */
function WorkBar({ toolCount, thought, expanded, onToggle }: { toolCount: number; thought?: boolean; expanded: boolean; onToggle: () => void }) {
  const { theme } = useTheme();
  const parts: string[] = [];
  if (thought) parts.push('Thought');
  if (toolCount > 0) parts.push(`${toolCount} tool${toolCount === 1 ? '' : 's'}`);
  return (
    <Pressable
      onPress={onToggle}
      hitSlop={6}
      style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 7, height: 28, paddingHorizontal: 12, borderRadius: 14, backgroundColor: theme.color.fillTertiary, borderWidth: 0.5, borderColor: theme.color.separator }}
    >
      <Icon name={toolCount === 0 && thought ? 'spark' : 'terminal'} size={12} color={toolCount === 0 && thought ? theme.color.purple : theme.color.inkSecondary} />
      <Text style={{ fontSize: 12, fontWeight: '600', color: theme.color.inkSecondary }}>
        {parts.length ? parts.join(' · ') : 'Work'}
      </Text>
      <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} color={theme.color.inkTertiary} stroke={2.2} />
    </Pressable>
  );
}

function AgentBlocks({ job, onAnswer, answered }: { job: Job; onAnswer: (text: string) => void; answered: boolean }) {
  const { theme } = useTheme();
  const items = job.transcript ?? [];
  const live = job.status === 'running' || job.status === 'pending';

  // Same collapse signal as desktop ProjectDetail (WorkBar): once the turn is
  // settled and we have a final text/result block, hide everything before it
  // unless there's an unanswered question or a generated image to keep visible.
  const hasAsk = items.some((t) => t.kind === 'ask');
  const hasImage = items.some((t) => t.kind === 'image');
  let finalIdx = -1;
  for (let k = items.length - 1; k >= 0; k--) {
    if (items[k].kind === 'text' || items[k].kind === 'result') { finalIdx = k; break; }
  }
  const collapsible = !live && !hasAsk && !hasImage && finalIdx > 0
    && items.slice(0, finalIdx).some((t) => t.kind === 'tool' || t.kind === 'text' || t.kind === 'thinking');
  const [expanded, setExpanded] = useState(false);

  const renderItem = (it: TranscriptItem, i: number): React.ReactNode => {
    if (it.kind === 'tool') return <ToolRow key={i} item={it} />;
    if (it.kind === 'thinking') return <ThinkingRow key={i} item={it} />;
    if (it.kind === 'ask') return <QuestionCard key={i} ask={it.ask || it.text} onAnswer={onAnswer} answered={answered} />;
    if (it.kind === 'review') {
      const ok = it.verdict === 'approved';
      return (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, padding: 12, backgroundColor: (ok ? theme.color.green : theme.color.orange) + '14', borderWidth: 0.5, borderColor: (ok ? theme.color.green : theme.color.orange) + '40' }}>
          <Icon name="shield" size={15} color={ok ? theme.color.green : theme.color.orange} />
          <Text style={{ flex: 1, fontSize: 14, lineHeight: 19, color: theme.color.ink }}>{it.text || (ok ? 'Reviewer approved' : 'Reviewer asked for changes')}{it.resolved ? ' · resolved' : ''}</Text>
        </View>
      );
    }
    if (it.kind === 'image') {
      return (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, padding: 12, backgroundColor: theme.color.fillTertiary }}>
          <Icon name="image" size={16} color={theme.color.purple} />
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, color: theme.color.inkSecondary }}>{it.alt || it.text || 'Generated image'}</Text>
        </View>
      );
    }
    if (it.text && it.text.trim()) {
      return <Text key={i} style={{ fontSize: 16, lineHeight: 24, color: theme.color.ink }}>{it.text.trim()}</Text>;
    }
    return null;
  };

  // Render a list, gathering consecutive tool steps into one flat ToolGroupCard.
  const pushRun = (target: React.ReactNode[], list: TranscriptItem[], base: number) => {
    for (let i = 0; i < list.length; i++) {
      if (list[i].kind === 'tool') {
        const run: TranscriptItem[] = [];
        while (i < list.length && list[i].kind === 'tool') { run.push(list[i]); i++; }
        i--;
        target.push(<ToolGroupCard key={`g${base}-${i}`} items={run} />);
      } else {
        const node = renderItem(list[i], base + i);
        if (node) target.push(node);
      }
    }
  };

  const blocks: React.ReactNode[] = [];
  if (items.length) {
    if (collapsible) {
      const work = items.slice(0, finalIdx);
      const toolCount = work.filter((t) => t.kind === 'tool').length;
      const thought = work.some((t) => t.kind === 'thinking');
      blocks.push(<WorkBar key="work-bar" toolCount={toolCount} thought={thought} expanded={expanded} onToggle={() => setExpanded((e) => !e)} />);
      if (expanded) pushRun(blocks, work, 0);
      const finalNode = renderItem(items[finalIdx], finalIdx);
      if (finalNode) blocks.push(finalNode);
      // Items after the final answer (rare — usually a trailing review) stay visible.
      for (let i = finalIdx + 1; i < items.length; i++) { const node = renderItem(items[i], i); if (node) blocks.push(node); }
    } else {
      pushRun(blocks, items, 0);
    }
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
  // Turns are derived live from the unified SyncStore — every SSE `job` event
  // for this session is already upserted by App.tsx's global subscriber, so we
  // just filter + sort. The per-session AsyncStorage cache (turns.{sid}) is
  // gone: the store IS the cache.
  const allJobs = useSyncStore((s) => s.jobs);
  const turns = useMemo(
    () => (sessionId
      ? allJobs.filter((j) => j.sessionId === sessionId).slice().sort((a, b) => a.createdAt - b.createdAt)
      : []),
    [allJobs, sessionId],
  );
  const settled = useSyncStore((s) => s.settled);

  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<AttachChip[]>([]);
  const [pickingAttachment, setPickingAttachment] = useState(false);
  const [sending, setSending] = useState(false);
  const [schedOpen, setSchedOpen] = useState(false);
  // Per-session effort + model — remembered for the chat, sent with every message.
  const [effort, setEffort] = useState<Effort>(() => (initialSid ? cacheGet<Effort>(`effort.${initialSid}`, 'balanced') : 'balanced'));
  const [modelKey, setModelKey] = useState<string>(() => (initialSid ? cacheGet<string>(`model.${initialSid}`, 'auto') : 'auto'));
  const [models, setModels] = useState<ModelGroup[]>(() => cacheGet('models', []));
  const scrollRef = useRef<ScrollView>(null);

  const changeEffort = (e: Effort) => { setEffort(e); if (sessionId) cacheSet(`effort.${sessionId}`, e); };
  const changeModel = (key: string) => { setModelKey(key); if (sessionId) cacheSet(`model.${sessionId}`, key); };

  // Load the Mac's model catalog (cache-then-network) for the picker.
  useEffect(() => { api.listModels().then((g) => { setModels(g); cacheSet('models', g); }).catch(() => {}); }, []);

  // Top up the store on (re-)open so a chat that's been idle while another
  // tab was in front catches up cleanly.
  useEffect(() => { void pullSync(); }, [sessionId]);

  const loading = !settled && turns.length === 0 && !!sessionId;
  const liveTurn = turns.some((j) => j.status === 'running' || j.status === 'pending');

  // Auto-scroll to the newest content.
  useEffect(() => { const t = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 60); return () => clearTimeout(t); }, [turns]);

  // Core send — used by the composer AND by answering a question's option.
  // `chips` is captured at call time so the optimistic clear of `attachments`
  // can happen synchronously without losing the bytes for the in-flight send.
  const dispatchChat = useCallback((body: string, chips: AttachChip[] = []) => {
    setSending(true);
    const images = chips.filter((c) => c.kind === 'image').map((c) => ({ name: c.name, mime: c.mime, dataB64: c.dataB64 }));
    const files = chips.filter((c) => c.kind === 'file').map((c) => ({ name: c.name, mime: c.mime, kind: 'file' as const, dataB64: c.dataB64 }));
    return api.sendChat({
      projectId, text: body, sessionId, effort,
      ...(modelKey !== 'auto' ? { modelKey } : {}),
      ...(images.length ? { images } : {}),
      ...(files.length ? { files } : {}),
    })
      .then((res) => {
        if (!sessionId) {
          setSessionId(res.session.id); setTitle(res.session.title || body.slice(0, 40));
          cacheSet(`effort.${res.session.id}`, effort); cacheSet(`model.${res.session.id}`, modelKey);
        }
        // The new turn (and any subsequent live updates) flow through the
        // SyncStore via SSE; a one-shot pullSync covers the corner case where
        // the streaming job emits BEFORE we receive the session-creation event.
        void pullSync();
      })
      .finally(() => setSending(false));
  }, [projectId, sessionId, effort, modelKey]);

  const send = () => {
    const body = text.trim();
    // An empty body with attachments is valid — vision turns ("look at this") are
    // a real use case on desktop. Block only the truly-empty case.
    if ((!body && attachments.length === 0) || sending) return;
    const chips = attachments;
    setText('');
    setAttachments([]);
    dispatchChat(body, chips).catch(() => {
      // Restore both halves on failure so the user can retry.
      setText(body);
      setAttachments(chips);
    });
  };

  // ── Attachment pickers ──────────────────────────────────────────────────
  const MAX_ATTACHMENTS = 8;             // mirrors the Mac's per-turn image cap
  const MAX_BYTES = 16 * 1024 * 1024;    // mirrors the Mac's per-image byte cap

  const addChips = (next: AttachChip[]) => {
    if (!next.length) return;
    setAttachments((prev) => [...prev, ...next].slice(0, MAX_ATTACHMENTS));
  };

  const pickImage = async () => {
    if (pickingAttachment || attachments.length >= MAX_ATTACHMENTS) return;
    setPickingAttachment(true);
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) { Alert.alert('Photos permission needed', 'Grant photo library access in Settings to attach images.'); return; }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: true,
        quality: 0.7,
        base64: true,
        selectionLimit: MAX_ATTACHMENTS - attachments.length,
      });
      if (res.canceled) return;
      const chips: AttachChip[] = [];
      for (const a of res.assets) {
        const dataB64 = a.base64 ?? (a.uri ? await uriToBase64(a.uri).catch(() => '') : '');
        if (!dataB64) continue;
        // Rough byte estimate from base64 length (×3/4) — keeps oversize images out.
        if (dataB64.length * 0.75 > MAX_BYTES) {
          Alert.alert('Image too large', `“${a.fileName ?? 'image'}” is over 16 MB and was skipped.`);
          continue;
        }
        chips.push({
          id: `${Date.now()}-${chips.length}`,
          kind: 'image',
          name: a.fileName ?? `image-${Date.now()}.${a.mimeType?.split('/')[1] ?? 'jpg'}`,
          mime: a.mimeType ?? 'image/jpeg',
          dataB64,
          previewUri: a.uri,
        });
      }
      addChips(chips);
    } catch (e) {
      Alert.alert('Could not attach image', e instanceof Error ? e.message : 'Unknown error.');
    } finally { setPickingAttachment(false); }
  };

  const pickFile = async () => {
    if (pickingAttachment || attachments.length >= MAX_ATTACHMENTS) return;
    setPickingAttachment(true);
    try {
      const res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: '*/*' });
      if (res.canceled) return;
      const chips: AttachChip[] = [];
      for (const a of res.assets) {
        if (typeof a.size === 'number' && a.size > MAX_BYTES) {
          Alert.alert('File too large', `“${a.name}” is over 16 MB and was skipped.`);
          continue;
        }
        const dataB64 = a.uri ? await uriToBase64(a.uri).catch(() => '') : '';
        if (!dataB64) continue;
        chips.push({
          id: `${Date.now()}-${chips.length}`,
          kind: 'file',
          name: a.name || 'file',
          mime: a.mimeType ?? 'application/octet-stream',
          dataB64,
        });
      }
      addChips(chips);
    } catch (e) {
      Alert.alert('Could not attach file', e instanceof Error ? e.message : 'Unknown error.');
    } finally { setPickingAttachment(false); }
  };

  const removeChip = (id: string) => setAttachments((prev) => prev.filter((c) => c.id !== id));

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
            turns.map((j, i) => <Turn key={j.id} job={j} onAnswer={answer} answered={i < turns.length - 1} />)
          )}
        </ScrollView>
      )}

      {/* composer */}
      <View style={{ paddingBottom: insets.bottom + 10, borderTopWidth: 0.5, borderTopColor: theme.color.separator, backgroundColor: theme.color.bgGrouped }}>
        {/* effort + model strip — applies to this chat's messages */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingTop: 9 }}>
          <EffortDial value={effort} onChange={changeEffort} />
          <ModelPicker groups={models} value={modelKey} onChange={changeModel} />
          <View style={{ flex: 1 }} />
        </View>
        {/* attachment chips — appear above the text input once anything's picked */}
        {attachments.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 12, paddingTop: 10 }}>
            {attachments.map((c) => (
              <View
                key={c.id}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 38, paddingLeft: c.kind === 'image' ? 4 : 10, paddingRight: 8, borderRadius: 19, backgroundColor: theme.color.bgElevated, borderWidth: 0.5, borderColor: theme.color.separator, maxWidth: 220 }}
              >
                {c.kind === 'image' && c.previewUri ? (
                  <Image source={{ uri: c.previewUri }} style={{ width: 30, height: 30, borderRadius: 15 }} />
                ) : (
                  <View style={{ width: 24, height: 24, borderRadius: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.fillTertiary }}>
                    <Icon name={c.kind === 'image' ? 'image' : 'file'} size={13} color={theme.color.inkSecondary} />
                  </View>
                )}
                <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, color: theme.color.ink }}>{c.name}</Text>
                <Pressable onPress={() => removeChip(c.id)} hitSlop={8} style={{ width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.fillSecondary }}>
                  <Icon name="x" size={12} color={theme.color.inkSecondary} stroke={2.4} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        ) : null}
        {/* input row */}
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6, paddingHorizontal: 12, paddingTop: 8 }}>
          <Pressable onPress={openScheduler} hitSlop={6} style={{ width: 38, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="clock" size={19} color={theme.color.inkSecondary} />
          </Pressable>
          <Pressable onPress={pickImage} disabled={pickingAttachment || attachments.length >= MAX_ATTACHMENTS} hitSlop={6} style={{ width: 38, height: 44, alignItems: 'center', justifyContent: 'center', opacity: attachments.length >= MAX_ATTACHMENTS ? 0.4 : 1 }}>
            <Icon name="image" size={19} color={theme.color.inkSecondary} />
          </Pressable>
          <Pressable onPress={pickFile} disabled={pickingAttachment || attachments.length >= MAX_ATTACHMENTS} hitSlop={6} style={{ width: 38, height: 44, alignItems: 'center', justifyContent: 'center', opacity: attachments.length >= MAX_ATTACHMENTS ? 0.4 : 1 }}>
            <Icon name="file" size={19} color={theme.color.inkSecondary} />
          </Pressable>
          <View style={{ flex: 1, minHeight: 44, maxHeight: 130, borderRadius: 22, backgroundColor: theme.color.bgElevated, borderWidth: 0.5, borderColor: theme.color.separator, paddingHorizontal: 16, justifyContent: 'center' }}>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder={attachments.length ? 'Add a message (optional)…' : 'Message the agent…'}
              placeholderTextColor={theme.color.inkTertiary}
              multiline
              style={{ fontSize: 16, lineHeight: 21, color: theme.color.ink, paddingVertical: 11 }}
            />
          </View>
          <Pressable
            onPress={send}
            disabled={(!text.trim() && attachments.length === 0) || sending}
            style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: (text.trim() || attachments.length > 0) && !sending ? theme.color.blue : theme.color.fillSecondary }}
          >
            {sending ? <ActivityIndicator size="small" color="#fff" /> : <Icon name="send" size={19} color={(text.trim() || attachments.length > 0) ? '#fff' : theme.color.inkTertiary} />}
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
