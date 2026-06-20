/* Account auth — Login + Register screens. Replaces the QR/pairing-code
   onboarding: the phone signs in to an account on the server, then picks which
   Mac (host) to control (see Devices). On success we route to the device
   switcher so the user immediately chooses an active host. */

import React, { useState } from 'react';
import { View, Text, Pressable, TextInput, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { MaestroMark, Icon } from '../Icon';
import { signIn, signUp, AuthError } from '../auth';
import { setFlag, ONBOARDED } from '../storage';
import { registerForPush } from '../push';
import { pullSync } from '../syncStore';

const BLUE = '#007AFF';
const ONBOARD_BG = '#0a0b10';

function Field({
  label, value, onChange, placeholder, secure, keyboardType, autoFocus, onSubmit, returnKey,
}: {
  label: string;
  value: string;
  onChange: (t: string) => void;
  placeholder: string;
  secure?: boolean;
  keyboardType?: 'email-address' | 'default';
  autoFocus?: boolean;
  onSubmit?: () => void;
  returnKey?: 'next' | 'go' | 'done';
}) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13, fontWeight: '600', marginBottom: 7, marginLeft: 4 }}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor="rgba(255,255,255,0.3)"
        secureTextEntry={secure}
        keyboardType={keyboardType ?? 'default'}
        autoCapitalize={keyboardType === 'email-address' ? 'none' : 'words'}
        autoCorrect={false}
        autoComplete={secure ? 'password' : keyboardType === 'email-address' ? 'email' : 'name'}
        textContentType={secure ? 'password' : keyboardType === 'email-address' ? 'emailAddress' : 'name'}
        autoFocus={autoFocus}
        onSubmitEditing={onSubmit}
        returnKeyType={returnKey}
        style={{
          height: 52, borderRadius: 14, paddingHorizontal: 16,
          backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
          color: '#fff', fontSize: 16, fontWeight: '500',
        }}
      />
    </View>
  );
}

/** Shared form for both sign-in and sign-up. After success, register for push and
    route to the device switcher to pick a host. */
function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const isRegister = mode === 'register';

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = email.trim().length > 3 && password.length >= 8 && (!isRegister || name.trim().length > 0);

  const submit = async () => {
    if (!canSubmit || busy) return;
    setBusy(true); setError(null);
    try {
      if (isRegister) await signUp({ name: name.trim(), email: email.trim(), password });
      else await signIn({ email: email.trim(), password });
      setFlag(ONBOARDED, true);
      void registerForPush(); // closed-app notifications, now that there's a session
      void pullSync().catch(() => {}); // best-effort warm-up (no host yet → no-op)
      // Land on the device switcher so the user immediately picks a Mac to control.
      nav.reset({ index: 0, routes: [{ name: 'Devices', params: { firstRun: true } }] });
    } catch (e) {
      const msg = e instanceof AuthError
        ? (e.status === 401 || e.status === 403 ? 'Wrong email or password.' : e.message)
        : 'Couldn’t reach the server — check your connection.';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: ONBOARD_BG }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 28, paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={{ alignItems: 'center', marginBottom: 30 }}>
          <MaestroMark size={72} />
          <Text style={{ color: '#fff', fontSize: 27, fontWeight: '700', letterSpacing: -0.5, marginTop: 18 }}>
            {isRegister ? 'Create your account' : 'Welcome back'}
          </Text>
          <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 15, lineHeight: 21, textAlign: 'center', marginTop: 8, maxWidth: 300 }}>
            {isRegister ? 'Sign up to control the agents on your Mac from anywhere.' : 'Sign in to reach the agents running on your Mac.'}
          </Text>
        </View>

        {isRegister ? (
          <Field label="Name" value={name} onChange={(t) => { setName(t); if (error) setError(null); }} placeholder="Your name" autoFocus returnKey="next" />
        ) : null}
        <Field
          label="Email"
          value={email}
          onChange={(t) => { setEmail(t); if (error) setError(null); }}
          placeholder="you@example.com"
          keyboardType="email-address"
          autoFocus={!isRegister}
          returnKey="next"
        />
        <Field
          label="Password"
          value={password}
          onChange={(t) => { setPassword(t); if (error) setError(null); }}
          placeholder={isRegister ? 'At least 8 characters' : 'Your password'}
          secure
          returnKey="go"
          onSubmit={submit}
        />

        {error ? (
          <Text style={{ color: '#FF6961', fontSize: 14, fontWeight: '500', textAlign: 'center', marginTop: 4, marginBottom: 6 }}>{error}</Text>
        ) : null}

        <Pressable
          onPress={submit}
          disabled={!canSubmit || busy}
          style={({ pressed }) => ({
            height: 54, borderRadius: 980, marginTop: 12,
            backgroundColor: canSubmit && !busy ? BLUE : 'rgba(255,255,255,0.15)',
            alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.9 : 1,
          })}
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={{ color: '#fff', fontSize: 17, fontWeight: '600' }}>{isRegister ? 'Create account' : 'Sign in'}</Text>}
        </Pressable>

        <Pressable
          hitSlop={10}
          onPress={() => nav.navigate(isRegister ? 'Login' : 'Register')}
          style={{ alignSelf: 'center', marginTop: 22, flexDirection: 'row', gap: 6 }}
        >
          <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 15 }}>{isRegister ? 'Already have an account?' : 'New here?'}</Text>
          <Text style={{ color: BLUE, fontSize: 15, fontWeight: '600' }}>{isRegister ? 'Sign in' : 'Create one'}</Text>
        </Pressable>

        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 'auto', paddingTop: 28 }}>
          <Icon name="lock" size={13} color="rgba(255,255,255,0.4)" />
          <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12 }}>Your Mac runs everything — the server only relays.</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

export function LoginScreen() { return <AuthForm mode="login" />; }
export function RegisterScreen() { return <AuthForm mode="register" />; }
