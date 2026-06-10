import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, Animated, Easing, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import Svg, { Defs, LinearGradient, Stop, Rect } from 'react-native-svg';
import { useTheme } from '../theme';
import { Icon, type IconName } from '../Icon';
import { Card, Mono } from '../ui';

type TabKey = 'drafts' | 'rendering' | 'published';
type DraftStatus = 'await' | 'draft';

interface Draft {
  from: string;
  to: string;
  ar: number;
  status: DraftStatus;
  dur: string;
}

// 150deg gradients ported from the web design (linear-gradient(150deg, from, to)).
const DRAFTS: Draft[] = [
  { from: '#0E2A5E', to: '#30B0C7', ar: 9 / 16, status: 'await', dur: '0:24' },
  { from: '#2a1b4a', to: '#5856D6', ar: 9 / 16, status: 'draft', dur: '0:18' },
  { from: '#1b3a2a', to: '#1F8A5B', ar: 1, status: 'draft', dur: '0:08' },
  { from: '#3a2a1b', to: '#FF9500', ar: 9 / 16, status: 'await', dur: '0:32' },
  { from: '#1b2a4a', to: '#007AFF', ar: 9 / 16, status: 'draft', dur: '0:15' },
  { from: '#3a1b2a', to: '#AF52DE', ar: 1, status: 'draft', dur: '0:11' },
];

const RENDERING: { name: string; eta: string; cost: string }[] = [
  { name: 'B-roll · Kling', eta: '~90s', cost: '3.40' },
  { name: 'Avatar · hero', eta: '~120s', cost: '3.20' },
];

const PUBLISHED: { icon: IconName; name: string; when: string; views: string }[] = [
  { icon: 'play', name: 'Launch film', when: '2h ago', views: '1.2k views' },
  { icon: 'send', name: 'Launch thread', when: 'Yesterday', views: '8.4k views' },
  { icon: 'image', name: 'Icon reveal', when: '2d ago', views: '640 views' },
];

const TABS: [TabKey, string][] = [
  ['drafts', 'Drafts'],
  ['rendering', 'Rendering'],
  ['published', 'Published'],
];

/** SVG gradient fill — RN has no native linear-gradient, so we paint one. */
function GradientFill({ from, to, radius = 0 }: { from: string; to: string; radius?: number }) {
  const id = `g_${from.slice(1)}_${to.slice(1)}`;
  return (
    <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
      <Defs>
        {/* ~150deg diagonal */}
        <LinearGradient id={id} x1="0.25" y1="0" x2="0.75" y2="1">
          <Stop offset="0" stopColor={from} />
          <Stop offset="1" stopColor={to} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" rx={radius} fill={`url(#${id})`} />
    </Svg>
  );
}

function Spinner({ size = 20, color = '#fff' }: { size?: number; color?: string }) {
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [spin]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 2,
        borderColor: 'rgba(255,255,255,0.3)',
        borderTopColor: color,
        transform: [{ rotate }],
      }}
    />
  );
}

function DraftCard({ d, width, onPress }: { d: Draft; width: number; onPress: () => void }) {
  const { theme } = useTheme();
  const awaiting = d.status === 'await';
  return (
    <Pressable
      onPress={onPress}
      style={{ width, aspectRatio: d.ar, borderRadius: 14, overflow: 'hidden', backgroundColor: d.from }}
    >
      <GradientFill from={d.from} to={d.to} />
      <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
        <Icon name="play" size={26} color="rgba(255,255,255,0.85)" />
      </View>
      <View
        style={{
          position: 'absolute',
          top: 8,
          left: 8,
          height: 20,
          paddingHorizontal: 8,
          borderRadius: 10,
          justifyContent: 'center',
          backgroundColor: awaiting ? 'rgba(255,149,0,0.9)' : 'rgba(0,0,0,0.4)',
        }}
      >
        <Text style={{ color: '#fff', fontSize: 10, fontWeight: '600' }}>{awaiting ? 'Awaiting approval' : 'Draft'}</Text>
      </View>
      <View
        style={{
          position: 'absolute',
          bottom: 8,
          right: 8,
          height: 18,
          paddingHorizontal: 6,
          borderRadius: 9,
          justifyContent: 'center',
          backgroundColor: 'rgba(0,0,0,0.5)',
        }}
      >
        <Text style={{ color: '#fff', fontSize: 10, fontWeight: '600', fontFamily: theme.fontFamily.mono }}>{d.dur}</Text>
      </View>
    </Pressable>
  );
}

function Preview({ d, onClose }: { d: Draft; onClose: () => void }) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000', zIndex: 60 }]}>
      <View style={{ flex: 1 }}>
        <GradientFill from={d.from} to={d.to} />
        <Pressable
          onPress={onClose}
          style={{
            position: 'absolute',
            top: insets.top + 8,
            left: 18,
            width: 34,
            height: 34,
            borderRadius: 17,
            backgroundColor: 'rgba(0,0,0,0.4)',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="chevronDown" size={20} color="#fff" />
        </Pressable>
        <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
          <View
            style={{
              width: 72,
              height: 72,
              borderRadius: 36,
              backgroundColor: 'rgba(255,255,255,0.22)',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="play" size={32} color="#fff" />
          </View>
        </View>
      </View>

      <View
        style={{
          backgroundColor: theme.color.bg,
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          paddingTop: 10,
          paddingHorizontal: 20,
          paddingBottom: insets.bottom + 30,
          maxHeight: '52%',
        }}
      >
        <View style={{ alignItems: 'center', marginBottom: 14 }}>
          <View style={{ width: 36, height: 5, borderRadius: 3, backgroundColor: theme.color.separatorStrong }} />
        </View>
        <ScrollView showsVerticalScrollIndicator={false}>
          <Text style={{ fontSize: 20, lineHeight: 24, fontWeight: '700', color: theme.color.ink, marginBottom: 8 }}>
            Launch film — vertical cut
          </Text>
          <Text style={{ fontSize: 15, lineHeight: 21, color: theme.color.inkSecondary, marginBottom: 12 }}>
            Maestro is live. One operator, a fleet of agents.
          </Text>
          <View style={{ flexDirection: 'row', gap: 6, marginBottom: 12 }}>
            {['YouTube', 'TikTok', 'IG'].map((p) => (
              <View key={p} style={{ height: 24, paddingHorizontal: 10, borderRadius: 12, justifyContent: 'center', backgroundColor: theme.color.fillSecondary }}>
                <Text style={{ fontSize: 12, fontWeight: '600', color: theme.color.inkSecondary }}>{p}</Text>
              </View>
            ))}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            <Mono style={{ fontSize: 13, fontWeight: '500' }}>Cost: $7.80</Mono>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <Icon name="shield" size={12} color={theme.color.green} />
              <Text style={{ fontSize: 13, fontWeight: '500', color: theme.color.green }}>AI label ✓ · C2PA ✓ · Consent ✓</Text>
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Pressable
              onPress={onClose}
              style={{ flex: 1, height: 48, borderRadius: theme.radius.pill, backgroundColor: theme.color.blue, alignItems: 'center', justifyContent: 'center' }}
            >
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>Approve &amp; schedule</Text>
            </Pressable>
            <Pressable
              style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: theme.color.fillSecondary, alignItems: 'center', justifyContent: 'center' }}
            >
              <View style={{ transform: [{ rotate: '-90deg' }] }}>
                <Icon name="arrowRight" size={18} color={theme.color.inkSecondary} />
              </View>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    </View>
  );
}

export function StudioScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const [tab, setTab] = useState<TabKey>('drafts');
  const [preview, setPreview] = useState<Draft | null>(null);
  const [trackW, setTrackW] = useState(0);

  const ti = TABS.findIndex((t) => t[0] === tab);
  const slide = useRef(new Animated.Value(ti)).current;
  useEffect(() => {
    Animated.timing(slide, { toValue: ti, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [ti, slide]);

  // 2-col masonry split
  const colA = DRAFTS.filter((_, i) => i % 2 === 0);
  const colB = DRAFTS.filter((_, i) => i % 2 === 1);
  const colWidth = (trackW - 10) / 2;

  const segInner = trackW > 0 ? (trackW - 6) / 3 : 0;
  const left = slide.interpolate({ inputRange: [0, 2], outputRange: [3, 3 + segInner * 2] });

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 6, paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
        {/* large title */}
        <View style={{ paddingHorizontal: 20, paddingBottom: 10 }}>
          <Text style={{ fontSize: 34, fontWeight: '700', letterSpacing: -0.7, color: theme.color.ink }}>Studio</Text>
        </View>

        {/* segmented control */}
        <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 16 }}>
          <View
            onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}
            style={{ flexDirection: 'row', padding: 3, backgroundColor: theme.color.fillSecondary, borderRadius: 10 }}
          >
            {trackW > 0 ? (
              <Animated.View
                style={{
                  position: 'absolute',
                  top: 3,
                  bottom: 3,
                  left,
                  width: segInner,
                  backgroundColor: theme.color.bgElevated,
                  borderRadius: 8,
                  ...cardShadowLite(),
                }}
              />
            ) : null}
            {TABS.map((t) => {
              const on = tab === t[0];
              return (
                <Pressable key={t[0]} onPress={() => setTab(t[0])} style={{ flex: 1, paddingVertical: 8, alignItems: 'center' }}>
                  <Text style={{ fontSize: 14, fontWeight: on ? '600' : '500', color: on ? theme.color.ink : theme.color.inkSecondary }}>
                    {t[1]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* DRAFTS — 2-col masonry */}
        {tab === 'drafts' ? (
          <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingBottom: 24 }}>
            {[colA, colB].map((col, ci) => (
              <View key={ci} style={{ flex: 1, gap: 10 }}>
                {col.map((d, i) => (
                  <DraftCard key={i} d={d} width={colWidth > 0 ? colWidth : 0} onPress={() => setPreview(d)} />
                ))}
              </View>
            ))}
          </View>
        ) : null}

        {/* RENDERING */}
        {tab === 'rendering' ? (
          <View style={{ paddingHorizontal: 16, paddingBottom: 24, gap: 12 }}>
            {RENDERING.map((r, i) => (
              <Card key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: 14 } as any}>
                <View style={{ width: 56, height: 56, borderRadius: 12, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
                  <GradientFill from="#0E2A5E" to="#30B0C7" />
                  <Spinner size={20} color="#fff" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: '600', color: theme.color.ink }}>{r.name}</Text>
                  <Text style={{ fontSize: 13, color: theme.color.inkTertiary, marginTop: 4 }}>
                    {r.eta} · <Text style={{ fontFamily: theme.fontFamily.mono }}>${r.cost}</Text>
                  </Text>
                </View>
                <Pressable>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: theme.color.red }}>Cancel</Text>
                </Pressable>
              </Card>
            ))}
          </View>
        ) : null}

        {/* PUBLISHED */}
        {tab === 'published' ? (
          <View style={{ paddingHorizontal: 16, paddingBottom: 24 }}>
            <Card style={{ borderRadius: 12 } as any}>
              {PUBLISHED.map((r, i) => (
                <Pressable
                  key={i}
                  onPress={() => nav.navigate('JobTimeline')}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    minHeight: 48,
                    paddingHorizontal: 16,
                    paddingVertical: 10,
                    borderBottomWidth: i < PUBLISHED.length - 1 ? StyleSheet.hairlineWidth : 0,
                    borderBottomColor: theme.color.separator,
                  }}
                >
                  <View style={{ width: 30, height: 30, borderRadius: 8, backgroundColor: theme.color.fillSecondary, alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name={r.icon} size={15} color={theme.color.inkSecondary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: '500', color: theme.color.ink }}>{r.name}</Text>
                    <Text style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 3 }}>
                      {r.when} · {r.views}
                    </Text>
                  </View>
                  <Icon name="chevronRight" size={16} color={theme.color.inkTertiary} />
                </Pressable>
              ))}
            </Card>
          </View>
        ) : null}
      </ScrollView>

      {preview ? <Preview d={preview} onClose={() => setPreview(null)} /> : null}
    </View>
  );
}

function cardShadowLite() {
  return {
    shadowColor: '#000',
    shadowOpacity: 0.14,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  };
}
