import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, Animated } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useTheme } from '../theme';
import { Icon, type IconName } from '../Icon';
import { Card, Mono } from '../ui';
import { api, type Approval, type ApprovalKind, type Project } from '../api';
import { biometricGateEnabled, confirmBiometric } from '../biometrics';
import { useLive } from '../useLive';

type TintKey = 'blue' | 'purple' | 'green' | 'orange' | 'teal' | 'indigo' | 'red';
type Platform = 'x' | 'linkedin';

type Gate =
  | { id: string; type: 'plan'; label: string; icon: IconName; tint: TintKey; projName: string; age: string; faceid?: boolean; steps: string[]; cost: string }
  | { id: string; type: 'publish'; label: string; icon: IconName; tint: TintKey; projName: string; age: string; faceid?: boolean; caption: string; platforms: Platform[] }
  | { id: string; type: 'merge'; label: string; icon: IconName; tint: TintKey; projName: string; age: string; faceid?: boolean; stat: string }
  | { id: string; type: 'budget'; label: string; icon: IconName; tint: TintKey; projName: string; age: string; faceid?: boolean; over: string; cap: number };

const TINT_NAMES: TintKey[] = ['blue', 'purple', 'green', 'orange', 'teal', 'indigo', 'red'];

/** Resolve a project color name (e.g. 'blue') to a valid TintKey, with a fallback. */
function tintFromColor(color: string | undefined, fallback: TintKey): TintKey {
  return color && (TINT_NAMES as string[]).includes(color) ? (color as TintKey) : fallback;
}

/** Relative-age label ("1m", "2h", "3d") matching the design's compact format. */
function ageLabel(createdAt: number): string {
  const s = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Per-kind presentation defaults (icon, tint, body type, whether Face ID gates it). */
const KIND_META: Record<ApprovalKind, { type: Gate['type']; icon: IconName; tint: TintKey; faceid: boolean }> = {
  merge: { type: 'merge', icon: 'gitMerge', tint: 'green', faceid: true },
  budget: { type: 'budget', icon: 'gauge', tint: 'orange', faceid: false },
  publish: { type: 'publish', icon: 'send', tint: 'purple', faceid: true },
  deploy: { type: 'plan', icon: 'sliders', tint: 'blue', faceid: true },
  review: { type: 'plan', icon: 'sliders', tint: 'blue', faceid: false },
};

/** Pull a dollar amount out of free text like "+$4.10 over the $50 cap". */
function parseMoney(...sources: (string | null | undefined)[]): { over: string; cap: number } {
  const text = sources.filter(Boolean).join(' ');
  const overMatch = text.match(/\$?\s*([0-9]+(?:\.[0-9]+)?)/);
  const capMatch = text.match(/cap[^0-9]*\$?\s*([0-9]+)/i);
  const over = overMatch ? overMatch[1] : '0.00';
  const cap = capMatch ? Number(capMatch[1]) : 50;
  return { over, cap: Number.isFinite(cap) ? cap : 50 };
}

/** Map a live Approval into the Gate shape the existing JSX renders. */
function toGate(a: Approval, projects: Record<string, Project>): Gate {
  const meta = KIND_META[a.kind];
  const proj = a.projectId ? projects[a.projectId] : undefined;
  const projName = proj?.name ?? 'Workspace';
  const tint = tintFromColor(proj?.color, meta.tint);
  const base = {
    id: a.id,
    label: a.title,
    icon: meta.icon,
    tint,
    projName,
    age: ageLabel(a.createdAt),
    faceid: meta.faceid,
  };

  switch (meta.type) {
    case 'merge':
      return { ...base, type: 'merge', stat: a.detail || a.subtitle || '' };
    case 'budget': {
      const { over, cap } = parseMoney(a.subtitle, a.detail, a.title);
      return { ...base, type: 'budget', over, cap };
    }
    case 'publish':
      return {
        ...base,
        type: 'publish',
        caption: a.detail || a.subtitle || '',
        platforms: ['x', 'linkedin'],
      };
    case 'plan':
    default: {
      const steps = (a.detail || a.subtitle || '')
        .split(/\n|·|;/)
        .map((s) => s.trim())
        .filter(Boolean);
      return {
        ...base,
        type: 'plan',
        steps: steps.length ? steps : [a.subtitle || a.title],
        cost: '0.00',
      };
    }
  }
}

function useTints(): Record<TintKey, string> {
  const { theme } = useTheme();
  return {
    blue: theme.color.blue, purple: theme.color.purple, green: theme.color.green,
    orange: theme.color.orange, teal: theme.color.teal, indigo: theme.color.indigo, red: theme.color.red,
  };
}

const PLATFORM_GLYPH: Record<Platform, (color: string, size: number) => React.ReactNode> = {
  x: (color, size) => (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M17.5 3h3l-6.5 7.4L21.5 21h-5.9l-4.3-5.6L6.3 21H3.3l7-8L2.8 3h6l3.9 5.2L17.5 3Z" fill={color} />
    </Svg>
  ),
  linkedin: (color, size) => (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x="3.5" y="3.5" width="17" height="17" rx="3" fill="none" stroke={color} strokeWidth={1.8} />
      <Path d="M7 10v6M7 7.5v.01M11 16v-3.5a1.5 1.5 0 0 1 3 0V16M11 16v-6" stroke={color} strokeWidth={1.8} fill="none" strokeLinecap="round" />
    </Svg>
  ),
};

function PlanBody({ g }: { g: Extract<Gate, { type: 'plan' }> }) {
  const { theme } = useTheme();
  return (
    <View>
      <View style={{ gap: 9, marginBottom: 12 }}>
        {g.steps.map((s, i) => (
          <View key={i} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
            <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.fillSecondary }}>
              <Text style={{ fontSize: 12, fontWeight: '700', fontFamily: theme.fontFamily.mono, color: theme.color.inkSecondary }}>{i + 1}</Text>
            </View>
            <Text style={{ flex: 1, fontSize: 15, lineHeight: 20, fontWeight: '500', color: theme.color.ink }}>{s}</Text>
          </View>
        ))}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Mono style={{ fontSize: 14, fontWeight: '600', color: theme.color.inkSecondary }}>≈ ${g.cost} · ~6 min</Mono>
        <View style={{ flex: 1 }} />
        <Text style={{ fontSize: 14, fontWeight: '600', color: theme.color.blue }}>View full plan →</Text>
      </View>
    </View>
  );
}

function PublishBody({ g }: { g: Extract<Gate, { type: 'publish' }> }) {
  const { theme } = useTheme();
  const platformColor: Record<Platform, string> = { x: theme.color.ink, linkedin: theme.color.blue };
  return (
    <View style={{ flexDirection: 'row', gap: 14 }}>
      <View style={{ width: 74, height: 132, borderRadius: 12, backgroundColor: '#2c3a63', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="play" size={22} color="rgba(255,255,255,0.8)" />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15, lineHeight: 21, color: theme.color.ink, marginBottom: 10 }}>{g.caption}</Text>
        <View style={{ flexDirection: 'row', gap: 6, marginBottom: 10 }}>
          {g.platforms.map((p) => (
            <View key={p} style={{ width: 26, height: 26, borderRadius: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.fillSecondary }}>
              {PLATFORM_GLYPH[p](platformColor[p], 14)}
            </View>
          ))}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Icon name="shield" size={12} color={theme.color.green} />
          <Text style={{ fontSize: 12, fontWeight: '600', color: theme.color.green }}>AI label ✓ · C2PA ✓</Text>
        </View>
      </View>
    </View>
  );
}

function MergeBody({ g }: { g: Extract<Gate, { type: 'merge' }> }) {
  const { theme } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, backgroundColor: 'rgba(52,199,89,0.08)', borderWidth: 0.5, borderColor: 'rgba(52,199,89,0.25)' }}>
      <Icon name="check" size={16} color={theme.color.green} stroke={2.6} />
      <Mono style={{ flex: 1, fontSize: 14, lineHeight: 18, fontWeight: '500', color: theme.color.ink }}>{g.stat}</Mono>
      <Text style={{ fontSize: 14, fontWeight: '600', color: theme.color.blue }}>Review diff →</Text>
    </View>
  );
}

function BudgetBody({ g }: { g: Extract<Gate, { type: 'budget' }> }) {
  const { theme } = useTheme();
  const options: { label: string; icon: IconName; primary: boolean; danger: boolean }[] = [
    { label: 'Raise cap to $60', icon: 'gauge', primary: true, danger: false },
    { label: 'Downgrade model', icon: 'command', primary: false, danger: false },
    { label: 'Abort run', icon: 'x', primary: false, danger: true },
  ];
  return (
    <View>
      <View style={{ alignItems: 'center', paddingTop: 4, paddingBottom: 14 }}>
        <Mono style={{ fontSize: 38, fontWeight: '700', letterSpacing: -0.8, color: theme.color.orange }}>+${g.over}</Mono>
        <Mono style={{ fontSize: 13, fontWeight: '500', color: theme.color.inkTertiary, marginTop: 6 }}>over the ${g.cap} cap</Mono>
      </View>
      <View style={{ gap: 8 }}>
        {options.map((o, i) => (
          <View
            key={i}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, paddingHorizontal: 13, borderRadius: 11,
              backgroundColor: o.primary ? theme.color.blue + '1A' : theme.color.fillTertiary,
              borderWidth: 0.5,
              borderColor: o.primary ? theme.color.blue + '4D' : theme.color.separator,
            }}
          >
            <Icon name={o.icon} size={17} color={o.primary ? theme.color.blue : o.danger ? theme.color.red : theme.color.inkSecondary} />
            <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: o.danger ? theme.color.red : theme.color.ink }}>{o.label}</Text>
            {o.primary ? <Icon name="chevronRight" size={16} color={theme.color.inkTertiary} /> : null}
          </View>
        ))}
      </View>
    </View>
  );
}

function GateBody({ g }: { g: Gate }) {
  switch (g.type) {
    case 'plan':
      return <PlanBody g={g} />;
    case 'publish':
      return <PublishBody g={g} />;
    case 'merge':
      return <MergeBody g={g} />;
    case 'budget':
      return <BudgetBody g={g} />;
  }
}

function GateCard({ g, approving, onApprove, onReject }: { g: Gate; approving: boolean; onApprove: (g: Gate) => void; onReject: (g: Gate) => void }) {
  const { theme } = useTheme();
  const tints = useTints();
  const tint = tints[g.tint];

  const cover = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (approving) {
      Animated.timing(cover, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    }
  }, [approving, cover]);

  return (
    <Card style={{ marginHorizontal: 16, marginBottom: 16, borderRadius: 20, padding: 18, overflow: 'hidden' } as any}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 14 }}>
        <View style={{ width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: tint + '24' }}>
          <Icon name={g.icon} size={21} color={tint} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: theme.color.ink }}>{g.label}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: tint }} />
            <Text style={{ fontSize: 13, fontWeight: '500', color: theme.color.inkSecondary }}>{g.projName}</Text>
            <Mono style={{ fontSize: 12, color: theme.color.inkTertiary }}>· {g.age}</Mono>
          </View>
        </View>
      </View>

      <View style={{ marginBottom: 16 }}>
        <GateBody g={g} />
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Pressable
          onPress={() => onApprove(g)}
          style={{ flex: 1, flexDirection: 'row', height: 50, borderRadius: theme.radius.pill, backgroundColor: theme.color.blue, alignItems: 'center', justifyContent: 'center', gap: 7 }}
        >
          {g.faceid ? <Icon name="lock" size={15} color="#fff" /> : null}
          <Text style={{ color: '#fff', fontSize: 17, fontWeight: '600' }}>Approve</Text>
        </Pressable>
        <Pressable style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: theme.color.fillSecondary, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="command" size={19} color={theme.color.inkSecondary} />
        </Pressable>
        <Pressable onPress={() => onReject(g)} style={{ paddingHorizontal: 4 }}>
          <Text style={{ fontSize: 16, fontWeight: '600', color: theme.color.red }}>Reject</Text>
        </Pressable>
      </View>

      {/* approve cover */}
      <Animated.View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(52,199,89,0.12)', alignItems: 'center', justifyContent: 'center', opacity: cover }}>
        <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: theme.color.green, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="check" size={30} color="#fff" stroke={3} />
        </View>
      </Animated.View>
    </Card>
  );
}

export function ApprovalsScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [gates, setGates] = useState<Gate[]>([]);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  const sub = useMemo(() => (gates.length ? `${gates.length} waiting · approve from anywhere` : null), [gates.length]);

  const load = useCallback(async () => {
    try {
      const [approvals, projects] = await Promise.all([api.listApprovals('pending'), api.listProjects()]);
      const byId: Record<string, Project> = {};
      for (const p of projects) byId[p.id] = p;
      setGates(approvals.map((a) => toGate(a, byId)));
    } catch {
      // fail soft — keep whatever's already on screen
    }
  }, []);

  // Refetch on focus (and on mount) so newly-arrived gates and resolutions show up.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  // Real-time: a new gate or a resolution on the Mac updates the list instantly.
  useLive(['approval', 'job', 'session'], () => { void load(); });

  // Approve: plays the green-cover animation, hits the API, then refetches.
  const finish = (g: Gate) => {
    setApprovingId(g.id);
    void api.approveApproval(g.id).catch(() => {});
    setTimeout(() => {
      setGates((gs) => gs.filter((x) => x.id !== g.id));
      setApprovingId(null);
      void load();
    }, 420);
  };

  // Real biometric gate when the operator enabled it in Settings (else straight through).
  const approve = (g: Gate) => {
    if (biometricGateEnabled()) {
      void confirmBiometric(`Approve: ${g.label}`).then((ok) => { if (ok) finish(g); });
    } else {
      finish(g);
    }
  };

  const reject = (g: Gate) => {
    setGates((gs) => gs.filter((x) => x.id !== g.id));
    void api
      .denyApproval(g.id)
      .catch(() => {})
      .finally(() => {
        void load();
      });
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 6, paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
        {/* large title header */}
        <View style={{ paddingHorizontal: 20, paddingTop: 6, paddingBottom: 10 }}>
          <Text style={{ fontSize: 34, fontWeight: '700', letterSpacing: -0.7, color: theme.color.ink }}>Approvals</Text>
          {sub ? <Text style={{ marginTop: 6, fontSize: 15, lineHeight: 20, color: theme.color.inkSecondary }}>{sub}</Text> : null}
        </View>

        <View style={{ paddingTop: 6 }}>
          {gates.length === 0 ? (
            <View style={{ alignItems: 'center', paddingVertical: 80, paddingHorizontal: 30 }}>
              <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: 'rgba(52,199,89,0.14)', alignItems: 'center', justifyContent: 'center', marginBottom: 20 }}>
                <Icon name="check" size={38} color={theme.color.green} stroke={2.4} />
              </View>
              <Text style={{ fontSize: 22, fontWeight: '700', color: theme.color.ink, marginBottom: 8 }}>All clear</Text>
              <Text style={{ fontSize: 16, lineHeight: 22, color: theme.color.inkSecondary, textAlign: 'center' }}>Gates will appear here and as notifications.</Text>
            </View>
          ) : (
            gates.map((g) => <GateCard key={g.id} g={g} approving={approvingId === g.id} onApprove={approve} onReject={reject} />)
          )}
        </View>
      </ScrollView>
    </View>
  );
}
