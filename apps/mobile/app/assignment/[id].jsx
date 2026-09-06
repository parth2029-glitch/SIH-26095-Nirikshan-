import { Pressable, ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { cachedAssignment } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { s } from '../../lib/styles.js';

const Field = ({ label, value }) =>
  value === null || value === undefined ? null : (
    <View style={s.row}>
      <Text style={s.label}>{label}</Text>
      <Text style={s.body}>{value}</Text>
    </View>
  );

/**
 * Institute detail. Reads the cache the inbox filled rather than fetching:
 * `GET /api/assignments/mine` already embeds the whole institute so that an
 * inspector who lost signal on the way to the site can still open this screen.
 */
export default function AssignmentDetail() {
  const { id } = useLocalSearchParams();
  const assignment = cachedAssignment(id);

  if (!assignment) {
    return (
      <View style={[s.screen, s.pad]}>
        <Text style={s.muted}>{t('institute.notCached')}</Text>
      </View>
    );
  }

  const { institute } = assignment;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Text style={s.h1}>{institute.name}</Text>
      <View style={s.card}>
        <Field label={t('institute.scheme')} value={t(`scheme.${institute.schemeType}`)} />
        <Field
          label={t('institute.district')}
          value={`${institute.district}, ${institute.state}`}
        />
        <Field label={t('institute.capacity')} value={institute.reportedCapacity} />
        <Field label={t('institute.occupancy')} value={institute.reportedOccupancy} />
        <Field
          label={t('institute.geofence')}
          value={t('institute.metres', { n: institute.geofenceRadiusM })}
        />
        <Field label={t('inbox.due')} value={new Date(assignment.dueDate).toLocaleDateString()} />
      </View>

      <Pressable style={s.button} onPress={() => router.push(`/inspect/${assignment.id}`)}>
        <Text style={s.buttonText}>{t('institute.startInspection')}</Text>
      </Pressable>
    </ScrollView>
  );
}
