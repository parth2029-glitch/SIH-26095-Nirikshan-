import { useEffect, useState } from 'react';
import { Pressable, Text } from 'react-native';
import * as sync from '../lib/sync.js';
import { t } from '../lib/i18n.js';
import { colour, s } from '../lib/styles.js';

/**
 * What the outbox is doing, in one line (§9).
 *
 * An inspector who cannot see whether their morning's work has left the phone
 * will re-enter it, so this says so plainly, and tapping it forces a drain
 * rather than waiting for the next tick.
 */
export default function SyncStatus() {
  const [counts, setCounts] = useState({});

  useEffect(() => sync.onChange(setCounts), []);

  const waiting = (counts.PENDING ?? 0) + (counts.FAILED ?? 0);
  const sending = counts.SENDING ?? 0;
  if (waiting + sending === 0) return null;

  const failed = counts.FAILED ?? 0;
  return (
    <Pressable onPress={() => sync.drain()}>
      <Text style={[s.muted, failed > 0 && { color: colour.danger }]}>
        {sending > 0 ? t('sync.sending', { n: sending }) : t('sync.queued', { n: waiting })}
      </Text>
    </Pressable>
  );
}
