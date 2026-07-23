/**
 * MacScreen — standalone AnyDesk-style remote Mac screen viewer for the regular
 * tab-based app. Uses the process-wide `ScreenViewerStore` singleton directly,
 * which is already driven by the `ScreenRuntime` bootstrapped in App.tsx. The
 * runtime manages enrollment detection, key material, E2EE frame decryption,
 * and authority — no controller context dependency.
 *
 * States rendered from the `ScreenViewModel`:
 *  - no-cap     : device not enrolled or screen.view not granted
 *  - offline    : Mac not reachable
 *  - idle       : ready, "View screen" button
 *  - requesting : waiting for first frame
 *  - live       : full-screen pinch-to-zoom viewer
 *  - error/busy/permission/source/revoked/expired : truthful messages + retry
 */
import React from 'react';
import {
  View,
  Text,
  Image,
  ScrollView,
  Pressable,
  useWindowDimensions,
  AppState,
  Animated,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme';
import { Icon, type IconName } from '../Icon';
import { getScreenViewerStore } from './controller/ScreenViewer';

const STATUS_LABEL: Record<string, string> = {
  'no-cap': 'Not enabled',
  offline: 'Offline',
  idle: 'Ready',
  requesting: 'Starting...',
  live: 'Live',
  'permission-required': 'Permission needed',
  'permission-denied': 'Denied',
  busy: 'Busy',
  'source-lost': 'Unavailable',
  'source-required': 'No display',
  error: 'Error',
  revoked: 'Revoked',
  expired: 'Expired',
};

const STATUS_TONE_COLOR: Record<string, (t: ReturnType<typeof useTheme>['theme']) => string> = {
  online: (t) => t.color.green,
  offline: (t) => t.color.orange,
  locked: (t) => t.color.red,
  pending: (t) => t.color.orange,
  neutral: (t) => t.color.inkTertiary,
};

export function MacScreenScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const { width, height } = useWindowDimensions();
  const [toolbarVisible, setToolbarVisible] = React.useState(true);
  const toolbarOpacity = React.useRef(new Animated.Value(1)).current;

  // The process-wide ScreenViewerStore — already wired to the ScreenRuntime
  const store = getScreenViewerStore();
  const snap = React.useSyncExternalStore(store.subscribe, store.getSnapshot);

  // Foreground-only streaming — stop on background or screen exit
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') store.stop('app backgrounded');
    });
    return () => {
      try { sub.remove(); } catch { /* */ }
      store.stop('screen route exit');
    };
  }, [store]);

  // Auto-hide toolbar after 4 seconds when live
  React.useEffect(() => {
    if (snap.vm.phase !== 'live') {
      setToolbarVisible(true);
      return;
    }
    const t = setTimeout(() => {
      Animated.timing(toolbarOpacity, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }).start(() => setToolbarVisible(false));
    }, 4000);
    return () => clearTimeout(t);
  }, [snap.vm.phase, toolbarVisible]);

  const showToolbar = () => {
    setToolbarVisible(true);
    Animated.timing(toolbarOpacity, {
      toValue: 1,
      duration: 200,
      useNativeDriver: true,
    }).start();
  };

  const vm = snap.vm;
  const isLive = vm.showFrame && snap.frameDataUri;
  const toneColor = (STATUS_TONE_COLOR[vm.statusTone] ?? STATUS_TONE_COLOR.neutral!)(theme);

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {isLive ? (
        /* ─── Full-screen live viewer ─── */
        <Pressable style={{ flex: 1 }} onPress={showToolbar}>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center' }}
            maximumZoomScale={5}
            minimumZoomScale={1}
            bouncesZoom
            centerContent
            showsHorizontalScrollIndicator={false}
            showsVerticalScrollIndicator={false}
          >
            <Image
              accessibilityLabel={vm.frameAccessibilityLabel}
              source={{ uri: snap.frameDataUri! }}
              resizeMode="contain"
              style={{ width, height: height - insets.top - insets.bottom - 50 }}
            />
          </ScrollView>

          {/* Floating status pill */}
          {toolbarVisible ? (
            <Animated.View
              style={{
                position: 'absolute',
                top: insets.top + 8,
                alignSelf: 'center',
                opacity: toolbarOpacity,
              }}
            >
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 7,
                  backgroundColor: 'rgba(0,0,0,0.7)',
                  paddingHorizontal: 14,
                  paddingVertical: 7,
                  borderRadius: 20,
                  borderWidth: 0.5,
                  borderColor: 'rgba(255,255,255,0.15)',
                }}
              >
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.color.green }} />
                <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>Live</Text>
                <View style={{ width: 1, height: 12, backgroundColor: 'rgba(255,255,255,0.2)' }} />
                <Icon name="eye" size={13} color="rgba(255,255,255,0.6)" />
                <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '600' }}>
                  View only
                </Text>
              </View>
            </Animated.View>
          ) : null}

          {/* Floating toolbar */}
          {toolbarVisible ? (
            <Animated.View
              style={{
                position: 'absolute',
                bottom: insets.bottom + 20,
                alignSelf: 'center',
                opacity: toolbarOpacity,
              }}
            >
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                  backgroundColor: 'rgba(0,0,0,0.7)',
                  paddingHorizontal: 8,
                  paddingVertical: 6,
                  borderRadius: 16,
                  borderWidth: 0.5,
                  borderColor: 'rgba(255,255,255,0.15)',
                }}
              >
                <ToolbarBtn icon="x" label="Disconnect" onPress={() => store.stop()} color={theme.color.red} />
                <View style={{ width: 0.5, height: 24, backgroundColor: 'rgba(255,255,255,0.15)' }} />
                <ToolbarBtn icon="arrowLeft" label="Back" onPress={() => nav.goBack()} color="rgba(255,255,255,0.7)" />
              </View>
            </Animated.View>
          ) : null}
        </Pressable>
      ) : (
        /* ─── Not-live state: centered placeholder ─── */
        <View style={{ flex: 1 }}>
          {/* Back button */}
          <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 16 }}>
            <Pressable
              onPress={() => nav.goBack()}
              hitSlop={8}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                height: 40,
              }}
            >
              <Icon name="arrowLeft" size={20} color="rgba(255,255,255,0.7)" />
              <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 16, fontWeight: '600' }}>Back</Text>
            </Pressable>
          </View>

          <View
            style={{
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              paddingHorizontal: 28,
              paddingBottom: insets.bottom + 60,
            }}
          >
            {/* Icon */}
            <View
              style={{
                width: 80,
                height: 80,
                borderRadius: 24,
                backgroundColor: 'rgba(255,255,255,0.06)',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 20,
              }}
            >
              <Icon
                name={vm.phase === 'no-cap' || vm.phase === 'revoked' || vm.phase === 'permission-denied' ? 'lock' : 'monitor'}
                size={36}
                color="rgba(255,255,255,0.3)"
              />
            </View>

            {/* Title */}
            <Text
              style={{
                fontSize: 22,
                fontWeight: '700',
                color: '#fff',
                marginBottom: 6,
                textAlign: 'center',
              }}
            >
              {vm.title}
            </Text>

            {/* Subtitle / description */}
            <Text
              style={{
                fontSize: 14,
                lineHeight: 20,
                color: 'rgba(255,255,255,0.5)',
                textAlign: 'center',
                marginBottom: 24,
                maxWidth: 300,
              }}
            >
              {vm.phase === 'no-cap'
                ? 'To view your Mac screen, enable Secure Controller mode in Settings and enroll with the "View Mac screen" capability.'
                : vm.subtitle}
            </Text>

            {/* Status badge */}
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingHorizontal: 12,
                height: 28,
                borderRadius: 14,
                backgroundColor: toneColor + '20',
                marginBottom: 20,
              }}
            >
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: toneColor }} />
              <Text style={{ fontSize: 12.5, fontWeight: '600', color: '#fff' }}>
                {STATUS_LABEL[vm.phase] ?? vm.phase}
              </Text>
            </View>

            {/* Action buttons */}
            {vm.showViewButton ? (
              <Pressable
                onPress={() => store.requestView()}
                accessibilityRole="button"
                accessibilityLabel="View Mac screen, view only"
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  width: '100%',
                  maxWidth: 280,
                  minHeight: 50,
                  paddingHorizontal: 22,
                  borderRadius: 25,
                  backgroundColor: theme.color.blue,
                  transform: [{ scale: pressed ? 0.98 : 1 }],
                })}
              >
                <Icon name="eye" size={18} color="#fff" />
                <Text style={{ fontSize: 16, fontWeight: '600', color: '#fff' }}>View screen</Text>
              </Pressable>
            ) : null}

            {vm.showStopButton ? (
              <Pressable
                onPress={() => store.stop()}
                accessibilityRole="button"
                accessibilityLabel="Stop viewing"
                style={{
                  width: '100%',
                  maxWidth: 280,
                  minHeight: 44,
                  paddingHorizontal: 18,
                  borderRadius: 22,
                  backgroundColor: 'rgba(255,255,255,0.1)',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontSize: 15, fontWeight: '600', color: theme.color.red }}>Stop viewing</Text>
              </Pressable>
            ) : null}

            {/* View-only safety note */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 24 }}>
              <Icon name="lock" size={12} color="rgba(255,255,255,0.3)" />
              <Text style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', fontWeight: '600' }}>
                {vm.viewOnlyNote}
              </Text>
            </View>

            {/* Encryption badge */}
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 5,
                marginTop: 12,
                paddingHorizontal: 10,
                paddingVertical: 5,
                borderRadius: 10,
                backgroundColor: 'rgba(255,255,255,0.04)',
              }}
            >
              <Icon name="shield" size={11} color="rgba(255,255,255,0.25)" />
              <Text style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', fontWeight: '500' }}>
                End-to-end encrypted
              </Text>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

function ToolbarBtn({
  icon,
  label,
  onPress,
  color,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  color: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 8,
      }}
    >
      <Icon name={icon} size={16} color={color} />
      <Text style={{ fontSize: 13, fontWeight: '600', color }}>{label}</Text>
    </Pressable>
  );
}
