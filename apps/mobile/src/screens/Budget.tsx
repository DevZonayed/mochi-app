import React, { useEffect, useRef } from 'react';
import { View, Text, Pressable, ScrollView, Animated, Easing, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import Svg, { Circle } from 'react-native-svg';
import { useTheme } from '../theme';
import { Icon } from '../Icon';
import { Mono, useProjects } from '../ui';

type ProjKey = 'atlas' | 'content' | 'scan' | 'brand' | 'infra';

const CAPS: { proj: ProjKey; spent: number; cap: number; paused?: boolean }[] = [
  { proj: 'atlas', spent: 14.2, cap: 50 },
  { proj: 'content', spent: 9.1, cap: 30 },
  { proj: 'scan', spent: 30, cap: 30, paused: true },
  { proj: 'brand', spent: 3.9, cap: 40 },
];

const LEDGER: [string, string, string][] = [
  ['14:02', 'Opus tokens · build pass', '0.43'],
  ['13:40', 'Video render · 24s', '28.80'],
  ['11:15', 'Search · 120 queries', '0.48'],
  ['09:30', 'Image gen · 48 @3x', '1.92'],
];

const SPARK = [12, 18, 9, 22, 30, 16, 24, 28, 20, 34, 26, 31];

function Spinner({ color, size = 16 }: { color: string; size?: number }) {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(a, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [a]);
  const spin = a.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 2,
        borderColor: color + '40',
        borderTopColor: color,
        transform: [{ rotate: spin }],
      }}
    />
  );
}

function HeroRing() {
  const { theme } = useTheme();
  const R = 88;
  const C = 2 * Math.PI * R;
  const pct = 38.2 / 200;
  return (
    <View style={{ alignItems: 'center', paddingTop: 8, paddingBottom: 18 }}>
      <View style={{ width: 220, height: 220 }}>
        <Svg width={220} height={220} viewBox="0 0 220 220" style={{ transform: [{ rotate: '-90deg' }] }}>
          <Circle cx={110} cy={110} r={R} fill="none" stroke={theme.color.fillSecondary} strokeWidth={16} />
          <Circle
            cx={110}
            cy={110}
            r={R}
            fill="none"
            stroke={theme.color.blue}
            strokeWidth={16}
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - pct)}
          />
        </Svg>
        <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' } as any}>
          <Mono style={{ fontSize: 44, fontWeight: '700', letterSpacing: -0.9 }}>$38.20</Mono>
          <Text style={{ fontSize: 15, fontWeight: '500', color: theme.color.inkTertiary, marginTop: 6 }}>of $200</Text>
        </View>
      </View>
      <Mono style={{ fontSize: 14, fontWeight: '500', color: theme.color.inkSecondary, marginTop: 8 }}>≈ $96 by Jun 30</Mono>
    </View>
  );
}

export function BudgetScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const projects = useProjects();
  const nav = useNavigation<any>();
  const mx = Math.max(...SPARK);

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 6, paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
        {/* back */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 2, paddingBottom: 4 }}>
          <Pressable onPress={() => nav.navigate('Tabs')} hitSlop={8}>
            <Icon name="arrowLeft" size={22} color={theme.color.blue} />
          </Pressable>
        </View>

        {/* large title */}
        <View style={{ paddingHorizontal: 20, paddingTop: 6, paddingBottom: 10 }}>
          <Text style={{ fontSize: 34, fontWeight: '700', letterSpacing: -0.7, color: theme.color.ink }}>Budget</Text>
        </View>

        {/* live expensive run pin */}
        <View
          style={{
            marginHorizontal: 16,
            marginBottom: 16,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            paddingVertical: 12,
            paddingHorizontal: 14,
            borderRadius: 14,
            backgroundColor: 'rgba(255,149,0,0.1)',
            borderWidth: 0.5,
            borderColor: 'rgba(255,149,0,0.3)',
          }}
        >
          <Spinner color={theme.color.orange} size={16} />
          <Text style={{ flex: 1, fontSize: 14, lineHeight: 17, fontWeight: '600', color: theme.color.ink }}>
            Rendering · <Text style={{ fontFamily: theme.fontFamily.mono }}>$3.40</Text> and counting
          </Text>
          <Pressable hitSlop={8}>
            <Text style={{ fontSize: 14, fontWeight: '600', color: theme.color.red }}>Cancel</Text>
          </Pressable>
        </View>

        <HeroRing />

        {/* today strip */}
        <View
          style={{
            marginHorizontal: 16,
            marginBottom: 20,
            padding: 16,
            borderRadius: 14,
            backgroundColor: theme.color.bgElevated,
            borderWidth: 0.5,
            borderColor: theme.color.separator,
          }}
        >
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 }}>
            <Text style={{ fontSize: 13, fontWeight: '600', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkTertiary }}>Today</Text>
            <Mono style={{ fontSize: 15, fontWeight: '700' }}>$6.40</Mono>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 4, height: 44 }}>
            {SPARK.map((v, i) => (
              <View
                key={i}
                style={{
                  flex: 1,
                  height: `${(v / mx) * 100}%`,
                  borderRadius: 2,
                  backgroundColor: i === SPARK.length - 1 ? theme.color.blue : theme.color.blue + '59',
                }}
              />
            ))}
          </View>
        </View>

        {/* per-project caps */}
        <View style={{ paddingHorizontal: 16 }}>
          <Text style={{ fontSize: 13, color: theme.color.inkSecondary, paddingHorizontal: 14, paddingBottom: 7, textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Per-project caps
          </Text>
          <View style={{ backgroundColor: theme.color.bgElevated, borderRadius: 12, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: theme.color.separator }}>
            {CAPS.map((c, i) => {
              const p = projects[c.proj];
              const pct = Math.min(1, c.spent / c.cap);
              const col = pct >= 1 ? theme.color.red : pct >= 0.75 ? theme.color.orange : p.color;
              const last = i === CAPS.length - 1;
              return (
                <View
                  key={i}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    minHeight: 48,
                    paddingVertical: 10,
                    paddingHorizontal: 16,
                    borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
                    borderBottomColor: theme.color.separator,
                  }}
                >
                  <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: p.color }} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 7 }}>
                      <Text style={{ fontSize: 15, fontWeight: '500', color: theme.color.ink }}>{p.name}</Text>
                      {c.paused ? (
                        <View style={{ height: 18, paddingHorizontal: 7, borderRadius: 9, backgroundColor: 'rgba(255,59,48,0.14)', justifyContent: 'center' }}>
                          <Text style={{ fontSize: 11, lineHeight: 18, fontWeight: '600', color: theme.color.red }}>Paused</Text>
                        </View>
                      ) : null}
                    </View>
                    <View style={{ height: 5, borderRadius: 3, backgroundColor: theme.color.fillSecondary, overflow: 'hidden' }}>
                      <View style={{ width: `${pct * 100}%`, height: '100%', borderRadius: 3, backgroundColor: col }} />
                    </View>
                  </View>
                  <Mono style={{ fontSize: 13, fontWeight: '500', color: theme.color.inkSecondary }}>
                    {`$${c.spent.toFixed(2)} / $${c.cap}`}
                  </Mono>
                </View>
              );
            })}
          </View>
        </View>

        {/* savings */}
        <View
          style={{
            marginHorizontal: 16,
            marginVertical: 20,
            padding: 16,
            borderRadius: 14,
            backgroundColor: theme.color.bgElevated,
            borderWidth: 0.5,
            borderColor: 'rgba(52,199,89,0.3)',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <View style={{ width: 38, height: 38, borderRadius: 11, backgroundColor: theme.color.green, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="dollar" size={18} color="#fff" />
          </View>
          <Text style={{ flex: 1, fontSize: 15, lineHeight: 21, fontWeight: '500', color: theme.color.ink }}>
            Caching & batch saved{' '}
            <Text style={{ fontWeight: '700', fontFamily: theme.fontFamily.mono, color: theme.color.green }}>$41.07</Text> this month
          </Text>
        </View>

        {/* ledger */}
        <View style={{ paddingHorizontal: 16, marginBottom: 24 }}>
          <Text style={{ fontSize: 13, color: theme.color.inkSecondary, paddingHorizontal: 14, paddingBottom: 7, textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Today's ledger
          </Text>
          <View style={{ backgroundColor: theme.color.bgElevated, borderRadius: 12, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: theme.color.separator }}>
            {LEDGER.map((r, i) => {
              const last = i === LEDGER.length - 1;
              return (
                <View
                  key={i}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    minHeight: 48,
                    paddingVertical: 10,
                    paddingHorizontal: 16,
                    borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
                    borderBottomColor: theme.color.separator,
                  }}
                >
                  <Mono style={{ fontSize: 13, fontWeight: '500', color: theme.color.inkTertiary, width: 44 }}>{r[0]}</Mono>
                  <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, lineHeight: 17, color: theme.color.ink }}>{r[1]}</Text>
                  <Mono style={{ fontSize: 14, fontWeight: '600' }}>${r[2]}</Mono>
                </View>
              );
            })}
          </View>
          <Pressable hitSlop={8} style={{ paddingHorizontal: 14, paddingTop: 7 }}>
            <Text style={{ fontSize: 13, color: theme.color.blue }}>View all on Mac →</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}
