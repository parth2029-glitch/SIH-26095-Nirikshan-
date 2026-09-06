import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { ApiError, login } from '../lib/api.js';
import * as session from '../lib/session.js';
import { t } from '../lib/i18n.js';
import { s } from '../lib/styles.js';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [checking, setChecking] = useState(true);

  // A stored token means the inspector is already signed in — skip straight to
  // the inbox rather than making them type on a phone in the field.
  useEffect(() => {
    session
      .token()
      .then((existing) => (existing ? router.replace('/inbox') : setChecking(false)))
      .catch(() => setChecking(false));
  }, []);

  async function submit() {
    if (!email.trim() || !password) return setError(t('login.required'));
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      router.replace('/inbox');
    } catch (err) {
      // The server's own code when it answered, the offline string when it did not.
      setError(
        err instanceof ApiError
          ? t(`login.${err.code}`, { defaultValue: err.message })
          : t('login.offline'),
      );
    } finally {
      setBusy(false);
    }
  }

  if (checking) return <ActivityIndicator style={{ marginTop: 48 }} />;

  return (
    <View style={[s.screen, s.pad]}>
      <Text style={s.h1}>{t('login.title')}</Text>

      <Text style={s.label}>{t('login.email')}</Text>
      <TextInput
        style={s.input}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        textContentType="username"
      />

      <Text style={s.label}>{t('login.password')}</Text>
      <TextInput
        style={s.input}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        textContentType="password"
        onSubmitEditing={submit}
      />

      {error && <Text style={s.danger}>{error}</Text>}

      <Pressable
        style={[s.button, busy && s.buttonDisabled]}
        onPress={submit}
        disabled={busy}
        accessibilityRole="button"
      >
        <Text style={s.buttonText}>{busy ? t('login.working') : t('login.submit')}</Text>
      </Pressable>
    </View>
  );
}
