/**
 * ControllerRemote — AnyDesk-style remote screen viewer tab. Full-dark background
 * with the live Mac screen, floating connection status bar at top, floating toolbar
 * at bottom. Minimal chrome for maximum screen real estate. Local-only pinch/zoom/pan
 * (no touch events are forwarded to the Mac — view only).
 *
 * Design: inspired by AnyDesk's minimal viewer with:
 * - Full black background
 * - Floating status pill at top (Live · View only)
 * - Floating toolbar at bottom (can auto-hide)
 * - Pinch-to-zoom ScrollView
 * - No header, maximum immersion
 */
import React from 'react';
import { View, Text, Image, ScrollView, Pressable, useWindowDimensions, AppState, Animated } from 'react-native';
import { useTheme } from '../../theme';
import { Icon } from '../../Icon';
import { useController } from './ControllerContext';
import { capabilityLabel } from '../../shadowUiModel';
import { Screen, PrimaryButton, GhostButton, ConnBadge, useInsets } from './parts';
import { getScreenViewerStore } from './ScreenViewer';

const STATUS_LABEL: Record<string, string> = {
  'no-cap': 'Not enabled', offline: 'Offline', idle: 'Ready', requesting: 'Starting...',
  live: 'Live', 'permission-required': 'Permission needed', 'permission-denied': 'Denied',
  busy: 'Busy', 'source-lost': 'Unavailable', 'source-required': 'No display',
  error: 'Error', revoked: 'Revoked', expired: 'Expired',
};

export function ControllerRemote() {
  const { theme } = useTheme();
  const { state } = useController();
  const insets = useInsets();
  const { width, height } = useWindowDimensions();
  const [toolbarVisible, setToolbarVisible] = React.useState(true);
  const toolbarOpacity = React.useRef(new Animated.Value(1)).current;

  const screenViewGranted = state.enrollment.grantedCapabilityLabels.includes(capabilityLabel('screen.view'));

  // Screen viewer store
  const store = getScreenViewerStore();
  const snap = React.useSyncExternalStore(store.subscribe, store.getSnapshot);

  // Set authority when state changes
  React.useEffect(() => {
    store.setAuthority({ screenViewGranted, online: state.connection.online, hostName: 'your Mac' });
  }, [store, screenViewGranted, state.connection.online]);

  // Foreground-only streaming
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => { if (s !== 'active') store.stop('app backgrounded'); });
    return () => { try { sub.remove(); } catch { /* */ } store.stop('screen route exit'); };
  }, [store]);

  // Auto-hide toolbar after 4 seconds when live
  React.useEffect(() => {
    if (snap.vm.phase !== 'live') {
      setToolbarVisible(true);
      return;
    }
    const t = setTimeout(() => {
      Animated.timing(toolbarOpacity, { toValue: 0, duration: 300, useNativeDriver: true }).start(() => setToolbarVisible(false));
    }, 4000);
    return () => clearTimeout(t);
  }, [snap.vm.phase, toolbarVisible]);

  const showToolbar = () => {
    setToolbarVisible(true);
    Animated.timing(toolbarOpacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
  };

  const vm = snap.vm;
  const isLive = vm.showFrame && snap.frameDataUri;

  return (
    <Screen>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {isLive ? (
          <Pressable style={{ flex: 1 }} onPress={showToolbar}>
            {/* Full-screen viewer */}
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
                style={{ width: width, height: height - insets.top - insets.bottom - 50 }}
              />
            </ScrollView>

            {/* Floating status bar at top */}
            {toolbarVisible ? (
              <Animated.View style={{ position: 'absolute', top: insets.top + 8, alignSelf: 'center', opacity: toolbarOpacity }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(10)', paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.15)' }}>
                  <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.color.green }} />
                  <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>Live</Text>
                  <View style={{ width: 1, height: 12, backgroundColor: 'rgba(255,255,255,0.2)' }} />
                  <Icon name="eye" size={13} color="rgba(255,255,255,0.6)" />
                  <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '600' }}>View only</Text>
                </View>
              </Animated.View>
            ) : null}

            {/* Floating toolbar at bottom */}
            {toolbarVisible ? (
              <Animated.View style={{ position: 'absolute', bottom: insets.bottom + 60, alignSelf: 'center', opacity: toolbarOpacity }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(0,0,0,0.7)', paddingHorizontal: 8, paddingVertical: 6, borderRadius: 16, borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.15)' }}>
                  <ToolbarButton icon="x" label="Disconnect" onPress={() => store.stop()} color={theme.color.red} />
                  <View style={{ width: 0.5, height: 24, backgroundColor: 'rgba(255,255,255,0.15)' }} />
                  <ToolbarButton icon="settings" label="Settings" onPress={showToolbar} color="rgba(255,255,255,0.7)" />
                </View>
              </Animated.View>
            ) : null}
          </Pressable>
        ) : (
          /* Not-live state: centered placeholder with action buttons */
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, paddingBottom: insets.bottom + 60 }}>
            {/* Background pattern */}
            <View style={{ width: 80, height: 80, borderRadius: 24, backgroundColor: 'rgba(255,255,255,0.06)', alignItems: 'center', justifyContent: 'center', marginBottom: 20 }}>
              <Icon name="monitor" size={36} color="rgba(255,255,255,0.3)" />
            </View>

            <Text style={{ fontSize: 22, fontWeight: '700', color: '#fff', marginBottom: 6, textAlign: 'center' }}>
              {screenViewGranted ? 'Mac Screen' : 'Screen Access'}
            </Text>

            <Text style={{ fontSize: 14, lineHeight: 20, color: 'rgba(255,255,255,0.5)', textAlign: 'center', marginBottom: 24, maxWidth: 280 }}>
              {!screenViewGranted
                ? 'Screen viewing is not enabled for this device. Re-enroll and check "View Mac screen" to enable it.'
                : !state.connection.online
                  ? 'Your Mac is offline. Connect to start viewing.'
                  : vm.phase === 'idle'
                    ? 'Ready to view your Mac screen. No input events are sent — view only.'
                    : vm.sourceLabel ?? 'Waiting for the screen stream...'}
            </Text>

            {/* Connection status */}
            <View style={{ marginBottom: 20 }}>
              <ConnBadge online={state.connection.online} />
            </View>

            {/* Action buttons */}
            {vm.showViewButton ? (
              <View style={{ width: '100%', maxWidth: 280 }}>
                <PrimaryButton title="View screen" icon="eye" onPress={() => store.requestView()} label="View Mac screen, view only" />
              </View>
            ) : null}

            {vm.showStopButton ? (
              <View style={{ width: '100%', maxWidth: 280 }}>
                <GhostButton title="Stop viewing" tone="danger" onPress={() => store.stop()} />
              </View>
            ) : null}

            {/* View-only safety note */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 20 }}>
              <Icon name="lock" size={12} color="rgba(255,255,255,0.3)" />
              <Text style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', fontWeight: '600' }}>{vm.viewOnlyNote}</Text>
            </View>
          </View>
        )}
      </View>
    </Screen>
  );
}

function ToolbarButton({ icon, label, onPress, color }: { icon: 'x' | 'settings' | 'maximize'; label: string; onPress: () => void; color: string }) {
  return (
    <Pressable onPress={onPress} accessibilityLabel={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8 }}>
      <Icon name={icon} size={16} color={color} />
      <Text style={{ fontSize: 13, fontWeight: '600', color }}>{label}</Text>
    </Pressable>
  );
}
