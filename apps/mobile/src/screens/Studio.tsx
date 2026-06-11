import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, Animated, Easing, StyleSheet, Image } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { Icon, type IconName } from '../Icon';
import { Card, Mono } from '../ui';
import { api, type Asset } from '../api';

type TabKey = 'drafts' | 'rendering' | 'published';
const TABS: [TabKey, string][] = [
  ['drafts', 'Drafts'],
  ['rendering', 'Rendering'],
  ['published', 'Published'],
];

const KIND_ICON: Record<string, IconName> = { image: 'image', video: 'play', audio: 'play', voiceover: 'play', other: 'image' };

function relTime(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function Spinner({ size = 20, color = '#fff' }: { size?: number; color?: string }) {
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [spin]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return <Animated.View style={{ width: size, height: size, borderRadius: size / 2, borderWidth: 2, borderColor: color + '55', borderTopColor: color, transform: [{ rotate }] }} />;
}

/** Thumbnail for any asset — real image, or a tinted card for video/audio. */
function Thumb({ a, height }: { a: Asset; height: number }) {
  const { theme } = useTheme();
  if (a.kind === 'image' && a.url) {
    return <Image source={{ uri: a.url }} style={{ width: '100%', height, borderRadius: 12, backgroundColor: theme.color.fillSecondary }} resizeMode="cover" />;
  }
  const tint = a.tint || theme.color.purple;
  return (
    <View style={{ width: '100%', height, borderRadius: 12, backgroundColor: tint + '33', alignItems: 'center', justifyContent: 'center' }}>
      <Icon name={KIND_ICON[a.kind] ?? 'image'} size={28} color={tint} />
    </View>
  );
}

function DraftCard({ a, width, onApprove }: { a: Asset; width: number; onApprove: () => void }) {
  const { theme } = useTheme();
  const h = a.kind === 'image' ? width : Math.round(width * 0.6);
  return (
    <View style={{ width, marginBottom: 10, backgroundColor: theme.color.bgElevated, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.color.separator, overflow: 'hidden' }}>
      <Thumb a={a} height={h} />
      <View style={{ padding: 10, gap: 8 }}>
        <Text numberOfLines={2} style={{ fontSize: 13, lineHeight: 17, color: theme.color.ink }}>{a.prompt || a.kind}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Mono style={{ fontSize: 12, color: theme.color.inkTertiary }}>{a.model}</Mono>
          <View style={{ flex: 1 }} />
          <Mono style={{ fontSize: 12, color: theme.color.inkSecondary }}>${a.cost.toFixed(3)}</Mono>
        </View>
        <Pressable onPress={onApprove} style={{ height: 32, borderRadius: 8, backgroundColor: theme.color.blue, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 13, fontWeight: '600', color: '#fff' }}>Send to Publishing</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function StudioScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<TabKey>('drafts');
  const [trackW, setTrackW] = useState(0);
  const [assets, setAssets] = useState<Asset[]>([]);

  useEffect(() => {
    const stop = api.poll(() => { api.listAssets().then(setAssets).catch(() => {}); }, 5000);
    return stop;
  }, []);

  const ti = TABS.findIndex((t) => t[0] === tab);
  const slide = useRef(new Animated.Value(ti)).current;
  useEffect(() => {
    Animated.timing(slide, { toValue: ti, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [ti, slide]);
  const segInner = trackW > 0 ? (trackW - 6) / 3 : 0;
  const left = slide.interpolate({ inputRange: [0, 2], outputRange: [3, 3 + segInner * 2] });

  const drafts = assets.filter((a) => a.status === 'done');
  const rendering = assets.filter((a) => a.status === 'queued' || a.status === 'generating');
  const published = assets.filter((a) => a.status === 'approved');
  const colWidth = (trackW - 10) / 2;
  const colA = drafts.filter((_, i) => i % 2 === 0);
  const colB = drafts.filter((_, i) => i % 2 === 1);

  const empty = (msg: string) => (
    <View style={{ alignItems: 'center', paddingVertical: 60, paddingHorizontal: 30 }}>
      <View style={{ width: 60, height: 60, borderRadius: 18, backgroundColor: theme.color.fillSecondary, alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
        <Icon name="clapper" size={28} color={theme.color.inkTertiary} />
      </View>
      <Text style={{ fontSize: 14, lineHeight: 20, color: theme.color.inkSecondary, textAlign: 'center' }}>{msg}</Text>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 6, paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
        <View style={{ paddingHorizontal: 20, paddingBottom: 10 }}>
          <Text style={{ fontSize: 34, fontWeight: '700', letterSpacing: -0.7, color: theme.color.ink }}>Studio</Text>
          <Text style={{ fontSize: 14, color: theme.color.inkSecondary, marginTop: 3 }}>Media generates on your Mac. Approve drafts to send them to Publishing.</Text>
        </View>

        {/* segmented control */}
        <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 16 }}>
          <View onLayout={(e) => setTrackW(e.nativeEvent.layout.width)} style={{ flexDirection: 'row', padding: 3, backgroundColor: theme.color.fillSecondary, borderRadius: 10 }}>
            {trackW > 0 ? <Animated.View style={{ position: 'absolute', top: 3, bottom: 3, left, width: segInner, backgroundColor: theme.color.bgElevated, borderRadius: 8, ...cardShadowLite() }} /> : null}
            {TABS.map((t) => {
              const on = tab === t[0];
              const count = t[0] === 'drafts' ? drafts.length : t[0] === 'rendering' ? rendering.length : published.length;
              return (
                <Pressable key={t[0]} onPress={() => setTab(t[0])} style={{ flex: 1, paddingVertical: 8, alignItems: 'center' }}>
                  <Text style={{ fontSize: 14, fontWeight: on ? '600' : '500', color: on ? theme.color.ink : theme.color.inkSecondary }}>{t[1]}{count > 0 ? ` · ${count}` : ''}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {tab === 'drafts' ? (
          drafts.length === 0 ? empty('No finished media yet. Generate from the Studio on your Mac.') : (
            <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingBottom: 24 }}>
              {[colA, colB].map((col, ci) => (
                <View key={ci} style={{ flex: 1 }}>
                  {col.map((a) => <DraftCard key={a.id} a={a} width={colWidth > 0 ? colWidth : 0} onApprove={() => { void api.approveAsset(a.id).then(() => api.listAssets().then(setAssets)).catch(() => {}); }} />)}
                </View>
              ))}
            </View>
          )
        ) : null}

        {tab === 'rendering' ? (
          rendering.length === 0 ? empty('Nothing rendering right now.') : (
            <View style={{ paddingHorizontal: 16, paddingBottom: 24, gap: 12 }}>
              {rendering.map((a) => (
                <Card key={a.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: 14 } as any}>
                  <View style={{ width: 56, height: 56, borderRadius: 12, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: (a.tint || theme.color.purple) + '33' }}>
                    <Spinner size={20} color={theme.color.purple} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: theme.color.ink }}>{a.prompt || a.kind}</Text>
                    <Text style={{ fontSize: 13, color: theme.color.inkTertiary, marginTop: 4 }}>{a.model} · <Mono style={{ fontSize: 13 }}>${a.cost.toFixed(3)}</Mono></Text>
                  </View>
                  <Pressable onPress={() => { void api.cancelAsset(a.id).then(() => api.listAssets().then(setAssets)).catch(() => {}); }} hitSlop={8}>
                    <Text style={{ fontSize: 14, fontWeight: '600', color: theme.color.red }}>Cancel</Text>
                  </Pressable>
                </Card>
              ))}
            </View>
          )
        ) : null}

        {tab === 'published' ? (
          published.length === 0 ? empty('Approved media appears here, ready for Publishing.') : (
            <View style={{ paddingHorizontal: 16, paddingBottom: 24, gap: 10 }}>
              {published.map((a) => (
                <Card key={a.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12 } as any}>
                  <View style={{ width: 44, height: 44, borderRadius: 10, overflow: 'hidden' }}>
                    <Thumb a={a} height={44} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '500', color: theme.color.ink }}>{a.prompt || a.kind}</Text>
                    <Text style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 3 }}>{a.kind} · {relTime(a.updatedAt)}</Text>
                  </View>
                  <Icon name="check" size={16} color={theme.color.green} />
                </Card>
              ))}
            </View>
          )
        ) : null}
      </ScrollView>
    </View>
  );
}

function cardShadowLite() {
  return { shadowColor: '#000', shadowOpacity: 0.14, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 2 };
}
