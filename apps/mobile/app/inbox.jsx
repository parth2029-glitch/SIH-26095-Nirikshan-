import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { router } from 'expo-router';
import { ApiError, cacheInbox, hydrateInbox, myAssignments } from '../lib/api.js';
import * as session from '../lib/session.js';
import * as sync from '../lib/sync.js';
import SyncStatus from '../components/SyncStatus.jsx';
import { t } from '../lib/i18n.js';
import { colour, s } from '../lib/styles.js';

const day = (iso) => new Date(iso).toLocaleDateString();

function Row({ item }) {
  const overdue = new Date(item.dueDate) < new Date();
  return (
    <Pressable style={s.card} onPress={() => router.push(`/assignment/${item.id}`)}>
      <Text style={s.h2}>{item.institute.name}</Text>
      <Text style={s.muted}>
        {t(`scheme.${item.institute.schemeType}`)} · {item.institute.district}
      </Text>
      <View style={s.row}>
        <Text style={[s.muted, overdue && { color: colour.danger }]}>
          {overdue ? t('inbox.overdue') : t('inbox.due', { date: day(item.dueDate) })}
        </Text>
        <Text style={s.muted}>{t(`inbox.allocation.${item.allocationType}`)}</Text>
      </View>
    </Pressable>
  );
}

export default function Inbox() {
  const [state, setState] = useState({ loading: true, rows: [], error: null });

  const load = useCallback(async () => {
    // Disk first, so an inspector with no signal sees yesterday's inbox
    // immediately rather than a spinner that resolves into an error.
    const stored = await hydrateInbox();
    if (stored) setState({ loading: false, rows: stored.assignments, error: null });

    try {
      const payload = await myAssignments('PENDING');
      cacheInbox(payload); // detail + form screens read from here, not the network
      setState({ loading: false, rows: payload.assignments, error: null });
    } catch (err) {
      // An expired token is the one failure that cannot be retried in place.
      if (err instanceof ApiError && err.status === 401) {
        await session.clear();
        return router.replace('/');
      }
      setState((prev) => ({
        ...prev,
        loading: false,
        // A cached inbox is not an error state — it is the offline one.
        error: stored ? t('inbox.offline') : t('inbox.loadFailed'),
      }));
    }
  }, []);

  useEffect(() => {
    load();
    // The one place the drain is started: the inbox is where an inspector lands
    // after signing in and after submitting, so it is where connectivity is
    // most likely to have come back.
    sync.start();
  }, [load]);

  if (state.loading) return <ActivityIndicator style={{ marginTop: 48 }} />;

  return (
    <FlatList
      style={s.screen}
      contentContainerStyle={s.pad}
      data={state.rows}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => <Row item={item} />}
      refreshControl={<RefreshControl refreshing={false} onRefresh={load} />}
      ListHeaderComponent={
        <>
          <SyncStatus />
          {state.error && state.rows.length > 0 ? (
            <Text style={s.muted}>{state.error}</Text>
          ) : null}
        </>
      }
      ListEmptyComponent={<Text style={s.muted}>{state.error ?? t('inbox.empty')}</Text>}
    />
  );
}
