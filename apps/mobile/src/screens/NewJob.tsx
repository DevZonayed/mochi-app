import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, ScrollView, TextInput } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme';
import { Icon, type IconName } from '../Icon';
import { Card, Mono } from '../ui';
import { api, type Effort as ApiEffort } from '../api';

type Effort = 'FAST' | 'BALANCED' | 'DEEP' | 'MAX';
type ModelId = 'auto' | 'opus' | 'sonnet' | 'haiku' | 'gpt';
type AutoKey = 'plan' | 'gated' | 'unatt';

/** A live project mapped into the shape the picker JSX consumes. */
interface LiveProj { id: string; name: string; color: string }

const EFFORT_STOPS: Effort[] = ['FAST', 'BALANCED', 'DEEP', 'MAX'];

/** Map the composer's effort dial to the API effort scale. */
const EFFORT_API: Record<Effort, ApiEffort> = {
  FAST: 'fast',
  BALANCED: 'balanced',
  DEEP: 'deep',
  MAX: 'max',
};

const EST: Record<Effort, [string, string]> = {
  FAST: ['0.30', '3'],
  BALANCED: ['0.60', '6'],
  DEEP: ['1.80', '36'],
  MAX: ['3.00', '72'],
};

const AUTOS: Record<AutoKey, [string, string]> = {
  plan: ['Plan first', "You'll approve the plan before anything runs."],
  gated: ['Gated', 'Runs freely but stops at every gate.'],
  unatt: ['Unattended', 'Runs end-to-end inside allowlists and caps.'],
};

const MODELS: { id: ModelId; name: string; sub: string; cost: number }[] = [
  { id: 'auto', name: 'Auto', sub: 'Routed per task', cost: 0 },
  { id: 'opus', name: 'Opus', sub: 'Most capable', cost: 3 },
  { id: 'sonnet', name: 'Sonnet', sub: 'Balanced', cost: 2 },
  { id: 'haiku', name: 'Haiku', sub: 'Fastest', cost: 1 },
  { id: 'gpt', name: 'GPT-4o', sub: 'Media & vision', cost: 2 },
];

function useEffortMeta() {
  const { theme } = useTheme();
  const meta: Record<Effort, { tint: string; bars: number }> = {
    FAST: { tint: theme.color.green, bars: 1 },
    BALANCED: { tint: theme.color.blue, bars: 2 },
    DEEP: { tint: theme.color.orange, bars: 3 },
    MAX: { tint: theme.color.red, bars: 4 },
  };
  return meta;
}

/** 4 ascending bars; filled up to `level` in `tint`, rest faded. */
function StrengthBars({ level, tint, size = 15 }: { level: number; tint: string; size?: number }) {
  const { theme } = useTheme();
  const heights = [0.42, 0.62, 0.82, 1];
  const bw = size * 0.17;
  const gap = size * 0.115;
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {heights.map((h, idx) => {
        const x = idx * (bw + gap) + bw * 0.3;
        const barH = size * h;
        const on = idx < level;
        return (
          <Rect
            key={idx}
            x={x}
            y={size - barH}
            width={bw}
            height={barH}
            rx={bw * 0.4}
            fill={on ? tint : theme.color.inkTertiary}
            opacity={on ? 1 : 0.3}
          />
        );
      })}
    </Svg>
  );
}

/** Effort dial — tap to cycle FAST → BALANCED → DEEP → MAX. */
function EffortDial({ value, onChange }: { value: Effort; onChange: (v: Effort) => void }) {
  const { theme } = useTheme();
  const meta = useEffortMeta();
  const m = meta[value];
  const showCost = value === 'DEEP' || value === 'MAX';
  const cycle = () => {
    const i = EFFORT_STOPS.indexOf(value);
    onChange(EFFORT_STOPS[(i + 1) % 4]);
  };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Pressable
        onPress={cycle}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 7,
          height: 34,
          paddingHorizontal: 13,
          borderRadius: theme.radius.pill,
          backgroundColor: m.tint + '1C',
          borderWidth: 1,
          borderColor: m.tint + '52',
        }}
      >
        <StrengthBars level={m.bars} tint={m.tint} size={15} />
        <Text style={{ fontSize: 11, fontWeight: '700', letterSpacing: 0.6, color: m.tint }}>{value}</Text>
        <View style={{ flexDirection: 'row', gap: 2, marginLeft: 1 }}>
          {[0, 1, 2, 3].map((d) => {
            const cur = d === EFFORT_STOPS.indexOf(value);
            return (
              <View
                key={d}
                style={{
                  width: 3,
                  height: 3,
                  borderRadius: 2,
                  backgroundColor: cur ? m.tint : theme.color.inkTertiary,
                  opacity: cur ? 1 : 0.35,
                }}
              />
            );
          })}
        </View>
      </Pressable>
      {showCost ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            height: 24,
            paddingHorizontal: 9,
            borderRadius: theme.radius.pill,
            backgroundColor: 'rgba(255,149,0,0.15)',
          }}
        >
          <Text style={{ fontSize: 13, fontWeight: '600', fontFamily: theme.fontFamily.mono, color: theme.color.orange }}>
            {`≈ ${value === 'MAX' ? '5×' : '3×'} cost · ${value === 'MAX' ? '12×' : '6×'} latency`}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function CostDots({ n }: { n: number }) {
  const { theme } = useTheme();
  if (!n) {
    return <Text style={{ fontSize: 11, fontWeight: '600', color: theme.color.green }}>auto</Text>;
  }
  return (
    <View style={{ flexDirection: 'row', gap: 2 }}>
      {[1, 2, 3].map((d) => (
        <View
          key={d}
          style={{
            width: 5,
            height: 5,
            borderRadius: 3,
            backgroundColor: d <= n ? theme.color.orange : theme.color.inkTertiary,
            opacity: d <= n ? 1 : 0.3,
          }}
        />
      ))}
    </View>
  );
}

/** Model switcher — pill that expands an inline pick list (provider glyph + tier + cost dots). */
function ModelSwitcher({ value, onChange }: { value: ModelId; onChange: (v: ModelId) => void }) {
  const { theme } = useTheme();
  const [open, setOpen] = useState(false);
  const cur = MODELS.find((m) => m.id === value) ?? MODELS[0];
  return (
    <View>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        style={{
          alignSelf: 'flex-start',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 7,
          height: 34,
          paddingHorizontal: 12,
          borderRadius: 9,
          backgroundColor: theme.color.fillSecondary,
        }}
      >
        <Icon name="spark" size={17} color={cur.id === 'auto' ? theme.color.inkSecondary : theme.color.ink} />
        <Text style={{ fontSize: 13, fontWeight: '600', color: theme.color.ink }}>{cur.name}</Text>
        <Icon name="chevronDown" size={13} color={theme.color.inkTertiary} />
      </Pressable>
      {open ? (
        <Card style={{ marginTop: 6, width: 248, borderRadius: 12, padding: 4 } as any}>
          {MODELS.map((m) => {
            const on = m.id === value;
            return (
              <Pressable
                key={m.id}
                onPress={() => {
                  onChange(m.id);
                  setOpen(false);
                }}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  paddingVertical: 9,
                  paddingHorizontal: 10,
                  borderRadius: 8,
                  backgroundColor: on ? theme.color.blue + '1A' : 'transparent',
                }}
              >
                <View
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 8,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: theme.color.fillTertiary,
                  }}
                >
                  <Icon name="spark" size={17} color={m.id === 'auto' ? theme.color.inkSecondary : theme.color.ink} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ fontSize: 15, fontWeight: '600', color: theme.color.ink }}>{m.name}</Text>
                  <Text style={{ fontSize: 11, color: theme.color.inkTertiary, marginTop: 2 }}>{m.sub}</Text>
                </View>
                {on ? <Icon name="check" size={16} color={theme.color.blue} stroke={2.6} /> : <CostDots n={m.cost} />}
              </Pressable>
            );
          })}
        </Card>
      ) : null}
    </View>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();
  return (
    <Text
      style={{
        fontSize: 13,
        fontWeight: '600',
        letterSpacing: 0.4,
        textTransform: 'uppercase',
        color: theme.color.inkTertiary,
        marginBottom: 9,
      }}
    >
      {children}
    </Text>
  );
}

export function NewJobScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();

  /** Resolve an API color name ('blue','teal',…) to a theme hex; fall back to raw value. */
  const resolveColor = (color: string): string => {
    const palette = theme.color as unknown as Record<string, string | undefined>;
    return palette[color] ?? color ?? theme.color.inkTertiary;
  };

  const [projects, setProjects] = useState<LiveProj[]>([]);
  const [proj, setProj] = useState<string | null>(null);
  const [goal, setGoal] = useState('');
  const [effort, setEffort] = useState<Effort>('BALANCED');
  const [model, setModel] = useState<ModelId>('auto');
  const [auto, setAuto] = useState<AutoKey>('plan');
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .listProjects()
      .then((list) => {
        if (!alive) return;
        const mapped = list.map((p) => ({ id: p.id, name: p.name, color: resolveColor(p.color) }));
        setProjects(mapped);
        setProj((cur) => cur ?? mapped[0]?.id ?? null);
      })
      .catch(() => {
        /* fail soft — picker stays empty */
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedProject = projects.find((p) => p.id === proj) ?? null;

  const submit = () => {
    if (running || !proj || !goal.trim()) return;
    setRunning(true);
    api
      .createAndRunJob({ projectId: proj, input: goal.trim(), effort: EFFORT_API[effort] })
      .then(() => {
        nav.goBack();
      })
      .catch(() => {
        // fail soft — re-enable submit so the user can retry
        setRunning(false);
      });
  };

  const est = EST[effort];
  const canSubmit = !running && !!proj && goal.trim().length > 0;

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      {/* grabber */}
      <View style={{ alignItems: 'center', paddingTop: insets.top > 0 ? 8 : 12 }}>
        <View style={{ width: 36, height: 5, borderRadius: 3, backgroundColor: theme.color.separatorStrong }} />
      </View>

      {/* header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 10, paddingBottom: 14 }}>
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 22, fontWeight: '700', letterSpacing: -0.2, color: theme.color.ink }}>
          New job{selectedProject ? ` · ${selectedProject.name}` : ''}
        </Text>
        <Pressable
          onPress={() => nav.navigate('Tabs')}
          style={{
            width: 30,
            height: 30,
            borderRadius: 15,
            backgroundColor: theme.color.fillSecondary,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="x" size={16} color={theme.color.inkSecondary} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 24 }}
        showsVerticalScrollIndicator={false}
      >
        {/* project picker */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 10, paddingBottom: 16 }}
        >
          {projects.map((pr) => {
            const on = proj === pr.id;
            return (
              <Pressable key={pr.id} onPress={() => setProj(pr.id)} style={{ alignItems: 'center', gap: 6 }}>
                <View
                  style={{
                    width: 50,
                    height: 50,
                    borderRadius: 15,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: pr.color + '29',
                    borderWidth: on ? 2 : 0,
                    borderColor: theme.color.blue,
                  }}
                >
                  <Text style={{ fontSize: 19, fontWeight: '800', color: pr.color }}>{pr.name[0] ?? '?'}</Text>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>

        {/* goal field */}
        <View
          style={{
            backgroundColor: theme.color.bgElevated,
            borderRadius: 14,
            borderWidth: 0.5,
            borderColor: theme.color.separator,
            padding: 14,
            marginBottom: 16,
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 10,
          }}
        >
          <TextInput
            value={goal}
            onChangeText={setGoal}
            placeholder="What should it do?"
            placeholderTextColor={theme.color.inkTertiary}
            multiline
            style={{
              flex: 1,
              minHeight: 48,
              fontSize: 17,
              lineHeight: 24,
              color: theme.color.ink,
              padding: 0,
              textAlignVertical: 'top',
            }}
          />
          <View
            style={{
              width: 38,
              height: 38,
              borderRadius: 19,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: theme.color.fillSecondary,
            }}
          >
            <Icon name="spark" size={18} color={theme.color.inkSecondary} />
          </View>
        </View>

        {/* effort */}
        <View style={{ marginBottom: 16 }}>
          <FieldLabel>Effort</FieldLabel>
          <EffortDial value={effort} onChange={setEffort} />
        </View>

        {/* model */}
        <View style={{ marginBottom: 16 }}>
          <FieldLabel>Model</FieldLabel>
          <ModelSwitcher value={model} onChange={setModel} />
        </View>

        {/* autonomy */}
        <View style={{ marginBottom: 16 }}>
          <FieldLabel>Autonomy</FieldLabel>
          <View
            style={{
              flexDirection: 'row',
              gap: 6,
              padding: 3,
              backgroundColor: theme.color.fillSecondary,
              borderRadius: 11,
            }}
          >
            {(Object.keys(AUTOS) as AutoKey[]).map((k) => {
              const on = auto === k;
              return (
                <Pressable
                  key={k}
                  onPress={() => setAuto(k)}
                  style={{
                    flex: 1,
                    paddingVertical: 9,
                    borderRadius: 8,
                    alignItems: 'center',
                    backgroundColor: on ? theme.color.bgElevated : 'transparent',
                  }}
                >
                  <Text style={{ fontSize: 13, fontWeight: '600', color: on ? theme.color.ink : theme.color.inkSecondary }}>
                    {AUTOS[k][0]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={{ fontSize: 13, lineHeight: 18, color: theme.color.inkSecondary, marginTop: 9 }}>
            {AUTOS[auto][1]}
          </Text>
        </View>

        {/* estimate */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 18 }}>
          <Icon name="spark" size={14} color={theme.color.purple} />
          <Mono style={{ fontSize: 14, fontWeight: '500', color: theme.color.inkSecondary }}>
            {`≈ $${est[0]} · ~${est[1]} min · `}
            <Text style={{ color: theme.color.green }}>within budget {'✓'}</Text>
          </Mono>
        </View>

        {/* primary action */}
        <Pressable
          onPress={canSubmit ? submit : undefined}
          disabled={!canSubmit}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 7,
            height: 50,
            borderRadius: theme.radius.pill,
            backgroundColor: theme.color.blue,
            opacity: canSubmit ? 1 : 0.5,
          }}
        >
          <Text style={{ fontSize: 17, fontWeight: '600', color: '#fff' }}>
            {running ? 'Starting…' : auto === 'plan' ? 'Get plan first' : 'Start job'}
          </Text>
          <Icon name="arrowRight" size={18} color="#fff" />
        </Pressable>
      </ScrollView>
    </View>
  );
}
