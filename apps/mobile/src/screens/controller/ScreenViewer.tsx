/* ScreenViewer — Phase 3D1 mobile view-only live screen surface (Section D.12).
 *
 * Renders every truthful phase from a pure `ScreenViewModel` (see shadowScreenUiModel)
 * plus the latest decoded frame as a data URI. The live frame sits in a ScrollView
 * that supports LOCAL pinch/zoom/pan ONLY — no tap/drag/key event ever leaves the
 * device (this component has no input callbacks that reach the wire). It never shows
 * an optimistic "Live" before the first decoded frame (the view-model enforces that).
 */
import React from 'react';
import { View, Text, Image, ScrollView, useWindowDimensions, AppState } from 'react-native';
import { useTheme } from '../../theme';
import { Icon } from '../../Icon';
import { Screen, ScreenHeader, StatusChip, PrimaryButton, GhostButton } from './parts';
import type { ScreenViewModel } from '../../shadowScreenUiModel';
import { ScreenViewerStore } from '../../shadowScreenViewerStore';

const STATUS_LABEL: Record<string, string> = {
  'no-cap': 'Not enabled', offline: 'Offline', idle: 'Ready', requesting: 'Starting…', live: 'Live',
  'permission-required': 'Permission needed', 'permission-denied': 'Denied', busy: 'Busy',
  'source-lost': 'Unavailable', 'source-required': 'No display', error: 'Error', revoked: 'Revoked', expired: 'Expired',
};

export function ScreenViewer({
  vm, frameDataUri, onView, onStop,
}: {
  vm: ScreenViewModel;
  frameDataUri: string | null;
  onView: () => void;
  onStop: () => void;
}) {
  const { theme } = useTheme();
  const { width } = useWindowDimensions();

  return (
    <Screen>
      {/* M-B: the subtitle carries the truthful ready/offline/permission/source copy —
          render it in the primary `ink` token so it clears WCAG AA on light (the muted
          secondary token was ≈3.4:1). Hierarchy is preserved by the 32px/700 title. */}
      <ScreenHeader
        title={vm.title}
        subtitle={vm.subtitle}
        subtitleColor={theme.color.ink}
        right={<StatusChip tone={vm.statusTone} label={STATUS_LABEL[vm.phase] ?? vm.phase} />}
      />

      {vm.showFrame && frameDataUri ? (
        <View style={{ flex: 1, backgroundColor: '#000', margin: 12, borderRadius: 14, overflow: 'hidden' }}>
          {/* Local-only pinch/zoom/pan. No event from here reaches the Mac. */}
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center' }}
            maximumZoomScale={4}
            minimumZoomScale={1}
            bouncesZoom
            centerContent
            showsHorizontalScrollIndicator={false}
            showsVerticalScrollIndicator={false}
          >
            <Image
              accessibilityLabel={vm.frameAccessibilityLabel}
              source={{ uri: frameDataUri }}
              resizeMode="contain"
              style={{ width: width - 24, aspectRatio: 16 / 9 }}
            />
          </ScrollView>
          <View style={{ position: 'absolute', top: 10, left: 10, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.color.green }} />
            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>Live · View only</Text>
          </View>
        </View>
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, gap: 14 }}>
          <View style={{ width: 64, height: 64, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.fillSecondary }}>
            <Icon name={vm.phase === 'no-cap' || vm.phase === 'permission-denied' || vm.phase === 'revoked' ? 'lock' : 'monitor'} size={28} color={theme.color.inkSecondary} />
          </View>
          {vm.sourceLabel ? (
            // M-B: source/status label in `ink` (AA-passing on light); size keeps it subordinate.
            <Text style={{ color: theme.color.ink, fontSize: 13, textAlign: 'center' }}>{vm.sourceLabel}</Text>
          ) : null}
        </View>
      )}

      <View style={{ paddingHorizontal: 16, paddingBottom: 20, gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
          {/* M-B: this standing safety note MUST clear WCAG AA. `ink` composites to
              ≈21:1 on white / ≈18:1 on systemGrouped (measured in shadowScreenContrast.test);
              the lock glyph stays muted (decorative, exempt). */}
          <Icon name="lock" size={13} color={theme.color.inkSecondary} />
          <Text style={{ color: theme.color.ink, fontSize: 12.5, fontWeight: '600', textAlign: 'center' }}>{vm.viewOnlyNote}</Text>
        </View>
        {vm.showStopButton ? (
          <GhostButton title="Stop viewing" tone="danger" onPress={onStop} />
        ) : null}
        {vm.showViewButton ? (
          <PrimaryButton title="View screen" icon="monitor" onPress={onView} label="View the Mac screen, view only" />
        ) : null}
      </View>
    </Screen>
  );
}

// The process-wide viewer store singleton. A production ScreenStreamClient is
// attached to it by the app runtime; the durable controller feeds authority.
let storeSingleton: ScreenViewerStore | null = null;
export function getScreenViewerStore(): ScreenViewerStore {
  if (!storeSingleton) storeSingleton = new ScreenViewerStore();
  return storeSingleton;
}

/**
 * The top-level "Screen" section for the controller shell. Given the live grant +
 * online authority (from the durable controller), renders the viewer, which shows
 * the truthful no-cap / offline / idle / requesting / live / … states.
 */
export function ScreenSection({ screenViewGranted, online, hostName }: { screenViewGranted: boolean; online: boolean; hostName: string }) {
  const store = getScreenViewerStore();
  const snap = React.useSyncExternalStore(store.subscribe, store.getSnapshot);

  React.useEffect(() => {
    store.setAuthority({ screenViewGranted, online, hostName });
  }, [store, screenViewGranted, online, hostName]);

  // Foreground-only: leaving the Screen route OR backgrounding the app stops the
  // stream immediately (clears image + key). No optimistic restart.
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => { if (s !== 'active') store.stop('app backgrounded'); });
    return () => { try { sub.remove(); } catch { /* */ } store.stop('screen route exit'); };
  }, [store]);

  return (
    <ScreenViewer
      vm={snap.vm}
      frameDataUri={snap.frameDataUri}
      onView={() => store.requestView()}
      onStop={() => store.stop()}
    />
  );
}
