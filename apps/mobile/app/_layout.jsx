import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { t } from '../lib/i18n.js';
import { colour } from '../lib/styles.js';

/**
 * The whole navigation graph: inbox → assignment detail → inspection form.
 * expo-router derives it from the files in `app/`, so there is no stack to wire
 * up by hand and no route table to keep in step with the screens.
 */
export default function Layout() {
  return (
    <>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colour.card },
          headerTintColor: colour.text,
          contentStyle: { backgroundColor: colour.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: t('app.name') }} />
        <Stack.Screen
          name="inbox"
          options={{ title: t('inbox.title'), headerBackVisible: false }}
        />
        <Stack.Screen name="assignment/[id]" options={{ title: t('institute.title') }} />
        <Stack.Screen name="inspect/[id]" options={{ title: t('inspect.title') }} />
      </Stack>
    </>
  );
}
