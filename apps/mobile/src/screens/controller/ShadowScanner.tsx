/**
 * ShadowScanner — Phase 3C2 enrollment initiation input. The HOST issues a signed
 * `maestro-shadow://enroll?…` bootstrap (shown as a QR on the desktop Settings →
 * Controllers pane). This is the ONLY sanctioned platform input route: scan that QR
 * with the camera, or paste the same deep-link string. The raw string is handed
 * straight to `runtime.parseBootstrap` — we never decode, display, or persist the
 * secret / nonce / keys here.
 */
import React from 'react';
import { View, Text, TextInput, ScrollView } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useTheme } from '../../theme';
import { Icon } from '../../Icon';
import { Screen, ScreenHeader, PrimaryButton, GhostButton, useInsets } from './parts';

export function ShadowScanner({ onScanned, onCancel, busy }: { onScanned: (raw: string) => void; onCancel: () => void; busy: boolean }) {
  const { theme } = useTheme();
  const insets = useInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [manual, setManual] = React.useState('');
  const [scanned, setScanned] = React.useState(false);

  const handleBarcode = React.useCallback((raw: string) => {
    if (scanned || busy) return;
    setScanned(true);
    onScanned(raw);
  }, [scanned, busy, onScanned]);

  const granted = permission?.granted;

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled">
        <ScreenHeader title="Connect to your Mac" subtitle="Open Settings → Controllers on your Mac and scan the code it shows." />

        <View style={{ marginHorizontal: 16, borderRadius: 20, overflow: 'hidden', backgroundColor: theme.color.bgElevated, borderWidth: 0.5, borderColor: theme.color.separator }}>
          <View style={{ aspectRatio: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }}>
            {granted ? (
              <CameraView
                style={{ flex: 1, alignSelf: 'stretch' }}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={busy || scanned ? undefined : (e) => handleBarcode(e.data)}
              />
            ) : (
              <View style={{ alignItems: 'center', padding: 24 }} accessibilityRole="text" accessibilityLabel="Camera access is needed to scan the code">
                <Icon name="camera" size={40} color={theme.color.inkTertiary} />
                <Text style={{ fontSize: 14, color: '#c9ccd6', marginTop: 12, textAlign: 'center' }}>
                  {permission ? 'Camera access is needed to scan the code.' : 'Checking camera…'}
                </Text>
                {permission && !granted ? (
                  <View style={{ marginTop: 14 }}>
                    <PrimaryButton title="Allow camera" icon="camera" onPress={() => void requestPermission()} label="Allow camera access" />
                  </View>
                ) : null}
              </View>
            )}
          </View>
        </View>

        <Text style={{ fontSize: 13, color: theme.color.inkTertiary, textAlign: 'center', marginTop: 14, marginBottom: 6 }}>or paste the link from your Mac</Text>
        <View style={{ marginHorizontal: 16 }}>
          <TextInput
            value={manual}
            onChangeText={setManual}
            placeholder="maestro-shadow://enroll?…"
            placeholderTextColor={theme.color.inkTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Paste the enrollment link from your Mac"
            style={{ minHeight: 48, borderRadius: 12, paddingHorizontal: 14, backgroundColor: theme.color.bgElevated, borderWidth: 0.5, borderColor: theme.color.separator, color: theme.color.ink, fontSize: 15, fontFamily: theme.fontFamily.mono }}
          />
          <View style={{ height: 12 }} />
          <PrimaryButton title={busy ? 'Checking…' : 'Continue'} icon="arrowRight" disabled={busy || manual.trim().length === 0} onPress={() => handleBarcode(manual.trim())} label="Continue with the pasted link" />
          <View style={{ height: 10 }} />
          <GhostButton title="Cancel" onPress={onCancel} />
        </View>
      </ScrollView>
    </Screen>
  );
}
