import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, TextInput, Animated, Easing, ActivityIndicator, Platform, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useTheme } from '../theme';
import { Icon } from '../Icon';
import { MaestroMark } from '../Icon';
import { api, setPairToken, getPairToken } from '../api';
import { setFlag, ONBOARDED } from '../storage';
import { registerForPush } from '../push';

const BLUE = '#007AFF';
const GREEN = '#34C759';
const ONBOARD_BG = '#0a0b10';

/** Pull the pairing token out of a scanned QR or a typed code.
   The Mac's QR encodes `maestro://pair?token=XXXX-XXXX-XXXX&relay=…`;
   a typed code is the bare `XXXX-XXXX-XXXX`. */
function extractToken(raw: string): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const m = s.match(/[?&]token=([^&]+)/i);
  if (m) return decodeURIComponent(m[1]).toUpperCase();
  // Bare code: groups of A–Z/2–9 separated by dashes (the desktop format).
  if (/^[A-Z0-9][A-Z0-9-]{4,}$/i.test(s)) return s.toUpperCase();
  return null;
}

/** Vertically sweeping scan line. */
function ScanShimmer() {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(a, { toValue: 1, duration: 1600, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(a, { toValue: 0, duration: 1600, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [a]);
  const translateY = a.interpolate({ inputRange: [0, 1], outputRange: [0, 146] });
  return (
    <Animated.View
      pointerEvents="none"
      style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 3, borderRadius: 2, backgroundColor: BLUE, opacity: 0.85, transform: [{ translateY }] }}
    />
  );
}

function ScanBracket({ corner }: { corner: 'tl' | 'tr' | 'bl' | 'br' }) {
  const top = corner === 'tl' || corner === 'tr';
  const left = corner === 'tl' || corner === 'bl';
  const style: ViewStyle = {
    position: 'absolute',
    width: 38,
    height: 38,
    [top ? 'top' : 'bottom']: 0,
    [left ? 'left' : 'right']: 0,
    borderColor: BLUE,
    borderTopWidth: top ? 4 : 0,
    borderBottomWidth: top ? 0 : 4,
    borderLeftWidth: left ? 4 : 0,
    borderRightWidth: left ? 0 : 4,
    borderTopLeftRadius: corner === 'tl' ? 6 : 0,
    borderTopRightRadius: corner === 'tr' ? 6 : 0,
    borderBottomLeftRadius: corner === 'bl' ? 6 : 0,
    borderBottomRightRadius: corner === 'br' ? 6 : 0,
  };
  return <View style={style} />;
}

function Welcome({ insets, onNext }: { insets: { top: number; bottom: number }; onNext: () => void }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', paddingHorizontal: 32, paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ marginBottom: 28 }}>
          <MaestroMark size={96} />
        </View>
        <Text style={{ textAlign: 'center', color: '#fff', fontSize: 32, fontWeight: '700', lineHeight: 35, letterSpacing: -0.6, marginBottom: 14 }}>
          Your fleet,{'\n'}in your pocket.
        </Text>
        <Text style={{ textAlign: 'center', color: 'rgba(255,255,255,0.7)', fontSize: 17, lineHeight: 25, maxWidth: 300 }}>
          Approve, watch, and steer the agents running on your Mac.
        </Text>
      </View>
      <Pressable
        onPress={onNext}
        style={({ pressed }) => ({
          width: '100%',
          height: 54,
          borderRadius: 980,
          backgroundColor: BLUE,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 14,
          opacity: pressed ? 0.9 : 1,
        })}
      >
        <Text style={{ color: '#fff', fontSize: 17, fontWeight: '600' }}>Pair with your Mac</Text>
      </Pressable>
      <Pressable hitSlop={8}>
        <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 15, fontWeight: '500' }}>What gets synced?</Text>
      </Pressable>
    </View>
  );
}

function Scanner({ insets, onScan }: { insets: { top: number; bottom: number }; onScan: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [entering, setEntering] = useState(false);
  const [code, setCode] = useState(getPairToken());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lockRef = useRef(false); // prevents the camera from firing onScan repeatedly

  // Ask for the camera once when we land on this step (native only).
  useEffect(() => {
    if (Platform.OS !== 'web' && permission && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
  }, [permission, requestPermission]);

  const tryPair = async (raw: string) => {
    const token = extractToken(raw);
    if (!token) { setError('That doesn’t look like a Maestro pairing code.'); lockRef.current = false; return; }
    setBusy(true); setError(null);
    setPairToken(token);
    const res = await api.verifyPairing();
    setBusy(false);
    if (res === 'invalid') { setError('That code didn’t match — check Settings ▸ Devices on your Mac.'); lockRef.current = false; return; }
    if (res === 'unreachable') { setError('Couldn’t reach the relay — check your connection and try again.'); lockRef.current = false; return; }
    void registerForPush(); // now paired — register this phone for closed-app notifications
    onScan(); // 'ok' (verified) or 'mac-offline' (saved; will connect when the Mac is online)
  };

  const onBarcode = ({ data }: { data: string }) => {
    if (lockRef.current || busy || entering) return;
    lockRef.current = true;
    void tryPair(data);
  };

  const save = () => { if (code.trim() && !busy) void tryPair(code); };

  const cameraReady = Platform.OS !== 'web' && !!permission?.granted;

  return (
    <View style={{ flex: 1, alignItems: 'center', paddingTop: insets.top + 8 }}>
      <View style={{ paddingHorizontal: 32, alignItems: 'center' }}>
        <Text style={{ color: '#fff', fontSize: 17, fontWeight: '600', lineHeight: 24, textAlign: 'center' }}>Scan the code on your Mac</Text>
        <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 14, lineHeight: 18, marginTop: 4, textAlign: 'center' }}>Settings &#9656; Devices</Text>
      </View>

      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: 230, height: 230, alignItems: 'center', justifyContent: 'center' }}>
          <ScanBracket corner="tl" />
          <ScanBracket corner="tr" />
          <ScanBracket corner="bl" />
          <ScanBracket corner="br" />
          <View style={{ position: 'absolute', top: 28, left: 28, right: 28, bottom: 28, borderRadius: 18, backgroundColor: '#000', overflow: 'hidden' }}>
            {cameraReady ? (
              <>
                <CameraView
                  style={{ flex: 1 }}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                  onBarcodeScanned={busy || entering ? undefined : onBarcode}
                />
                <ScanShimmer />
                {busy ? (
                  <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)' }}>
                    <ActivityIndicator color="#fff" />
                  </View>
                ) : null}
              </>
            ) : (
              <Pressable onPress={() => (permission?.canAskAgain ? requestPermission() : setEntering(true))} style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 }}>
                <Icon name="camera" size={30} color="rgba(255,255,255,0.6)" />
                <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, lineHeight: 18, textAlign: 'center', marginTop: 10 }}>
                  {permission && !permission.granted && !permission.canAskAgain
                    ? 'Camera access is off — enter the code instead.'
                    : 'Tap to enable the camera, or enter the code instead.'}
                </Text>
              </Pressable>
            )}
          </View>
        </View>
        {error ? (
          <Text style={{ color: '#FF6961', fontSize: 14, fontWeight: '500', textAlign: 'center', paddingHorizontal: 32, marginTop: 18 }}>{error}</Text>
        ) : null}
      </View>

      {entering ? (
        <View style={{ width: '100%', paddingHorizontal: 32, marginBottom: insets.bottom + 24 }}>
          <TextInput
            value={code}
            onChangeText={(t) => { setCode(t); if (error) setError(null); }}
            onSubmitEditing={save}
            autoFocus
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!busy}
            placeholder="XXXX-XXXX-XXXX"
            placeholderTextColor="rgba(255,255,255,0.35)"
            style={{ height: 52, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.1)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)', color: '#fff', fontSize: 18, fontWeight: '600', letterSpacing: 2, textAlign: 'center', marginBottom: 12 }}
          />
          <Pressable onPress={save} disabled={busy || !code.trim()} style={({ pressed }) => ({ height: 52, borderRadius: 980, backgroundColor: code.trim() && !busy ? BLUE : 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.9 : 1 })}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={{ color: '#fff', fontSize: 17, fontWeight: '600' }}>Pair with this code</Text>}
          </Pressable>
          <Pressable hitSlop={8} onPress={() => setEntering(false)} style={{ alignSelf: 'center', marginTop: 14 }}>
            <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 15, fontWeight: '500' }}>Use the camera instead</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable hitSlop={8} onPress={() => setEntering(true)} style={{ marginBottom: insets.bottom + 28 }}>
          <Text style={{ color: BLUE, fontSize: 16, fontWeight: '600' }}>Enter code instead</Text>
        </Pressable>
      )}
    </View>
  );
}

function ConfirmSheet({
  insets,
  paired,
  onConfirm,
  onEnable,
}: {
  insets: { bottom: number };
  paired: boolean;
  onConfirm: () => void;
  onEnable: () => void;
}) {
  const { theme } = useTheme();
  const pop = useRef(new Animated.Value(paired ? 0 : 1)).current;
  useEffect(() => {
    if (!paired) return;
    pop.setValue(0);
    Animated.spring(pop, { toValue: 1, friction: 5, tension: 90, useNativeDriver: true }).start();
  }, [paired, pop]);

  return (
    <View style={{ flex: 1, justifyContent: 'flex-end' }}>
      <View
        style={{
          backgroundColor: theme.color.bg,
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          paddingTop: 10,
          paddingHorizontal: 24,
          paddingBottom: insets.bottom + 36,
        }}
      >
        <View style={{ alignItems: 'center', marginBottom: 18 }}>
          <View style={{ width: 36, height: 5, borderRadius: 3, backgroundColor: theme.color.separatorStrong }} />
        </View>

        {paired ? (
          <View style={{ alignItems: 'center', paddingTop: 10, paddingBottom: 6 }}>
            <Animated.View
              style={{
                width: 72,
                height: 72,
                borderRadius: 36,
                backgroundColor: GREEN,
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 18,
                transform: [{ scale: pop }],
              }}
            >
              <Icon name="check" size={38} color="#fff" stroke={3} />
            </Animated.View>
            <Text style={{ color: theme.color.ink, fontSize: 24, fontWeight: '700', lineHeight: 26, marginBottom: 10 }}>Paired</Text>
            <Text style={{ color: theme.color.inkSecondary, fontSize: 16, lineHeight: 22, textAlign: 'center', marginBottom: 22 }}>
              Gates and finished jobs will arrive as notifications — enable to approve from anywhere.
            </Text>
            <Pressable
              onPress={onEnable}
              style={({ pressed }) => ({
                width: '100%',
                height: 52,
                borderRadius: 980,
                backgroundColor: BLUE,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.9 : 1,
              })}
            >
              <Text style={{ color: '#fff', fontSize: 17, fontWeight: '600' }}>Enable notifications</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 14,
                padding: 16,
                borderRadius: 14,
                backgroundColor: theme.color.bgElevated,
                borderWidth: 0.5,
                borderColor: theme.color.separator,
                marginBottom: 12,
              }}
            >
              <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: theme.color.fillSecondary, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="smartphone" size={22} color={theme.color.inkSecondary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: theme.color.ink, fontSize: 17, fontWeight: '600' }}>Your Mac</Text>
                <Text style={{ color: theme.color.inkSecondary, fontSize: 14, marginTop: 3 }}>Paired and ready</Text>
              </View>
            </View>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 9,
                paddingVertical: 12,
                paddingHorizontal: 14,
                borderRadius: 12,
                backgroundColor: 'rgba(52,199,89,0.08)',
                borderWidth: 0.5,
                borderColor: 'rgba(52,199,89,0.25)',
                marginBottom: 18,
              }}
            >
              <Icon name="lock" size={15} color={GREEN} />
              <Text style={{ flex: 1, color: theme.color.inkSecondary, fontSize: 13, lineHeight: 18 }}>
                End-to-end encrypted · the relay sees only ciphertext.
              </Text>
            </View>
            <Pressable
              onPress={onConfirm}
              style={({ pressed }) => ({
                width: '100%',
                height: 54,
                borderRadius: 980,
                backgroundColor: BLUE,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.9 : 1,
              })}
            >
              <Text style={{ color: '#fff', fontSize: 17, fontWeight: '600' }}>Confirm pairing</Text>
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

export function OnboardingScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const [step, setStep] = useState(0); // 0 welcome · 1 scanner · 2 confirm · 3 paired

  return (
    <View style={{ flex: 1, backgroundColor: ONBOARD_BG }}>
      {step === 0 ? <Welcome insets={insets} onNext={() => setStep(1)} /> : null}
      {step === 1 ? <Scanner insets={insets} onScan={() => setStep(2)} /> : null}
      {step >= 2 ? (
        <ConfirmSheet
          insets={insets}
          paired={step === 3}
          onConfirm={() => { void api.health().catch(() => {}); setStep(3); }}
          onEnable={() => { setFlag(ONBOARDED, true); nav.navigate('Tabs'); }}
        />
      ) : null}

      {/* Back affordance on the scanner step (returns to Welcome). */}
      {step === 1 ? (
        <Pressable
          onPress={() => setStep(0)}
          hitSlop={10}
          style={{ position: 'absolute', top: insets.top + 6, left: 16, zIndex: 40, width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.12)' }}
        >
          <Icon name="arrowLeft" size={20} color="#fff" />
        </Pressable>
      ) : null}
    </View>
  );
}
