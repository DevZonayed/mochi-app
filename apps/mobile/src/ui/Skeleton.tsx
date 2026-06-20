/* Loading placeholders for list rows. Used while the unified SyncStore is
   still bootstrapping (after a fresh install / unpair) so the UI never shows
   ghost data from a stale persistent cache. Cheap shimmer animation —
   Animated.loop with native driver so it's smooth on Android. */

import React, { useEffect, useRef } from 'react';
import { Animated, View, ViewStyle } from 'react-native';
import { useTheme } from '../theme';

/** A single shimmering block. Tints itself off the theme's separator color so
    it reads as "loading" on both light and dark backgrounds. */
export function Shimmer({ width, height, radius = 6, style }: { width?: number | string; height: number; radius?: number; style?: ViewStyle }) {
  const { theme } = useTheme();
  const opacity = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.9, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.4, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return (
    <Animated.View
      style={[
        { width: width as number | undefined, height, borderRadius: radius, backgroundColor: theme.color.separator, opacity },
        style,
      ]}
    />
  );
}

/** A row of skeleton placeholders that mirrors a project / chat list row:
    a circular badge on the left, two text lines on the right. */
export function SkeletonRow() {
  const { theme } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 13, padding: 15,
        backgroundColor: theme.color.bgElevated, borderRadius: 14,
        borderWidth: 0.5, borderColor: theme.color.separator,
      }}
    >
      <Shimmer width={46} height={46} radius={13} />
      <View style={{ flex: 1, gap: 8 }}>
        <Shimmer width="65%" height={14} />
        <Shimmer width="35%" height={11} />
      </View>
    </View>
  );
}

/** A vertical stack of `count` skeleton rows for an initial list paint. */
export function SkeletonList({ count = 4 }: { count?: number }) {
  return (
    <View style={{ paddingHorizontal: 16, gap: 10 }}>
      {Array.from({ length: count }).map((_, i) => <SkeletonRow key={i} />)}
    </View>
  );
}
