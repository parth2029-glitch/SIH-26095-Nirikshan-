import { useCallback, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { cachedAssignment, cachedChecklist } from '../../lib/api.js';
import Checklist, { countAnswered } from '../../components/Checklist.jsx';
import { t } from '../../lib/i18n.js';
import { s } from '../../lib/styles.js';

export default function Inspect() {
  const { id } = useLocalSearchParams();
  const assignment = cachedAssignment(id);
  const checklist = assignment && cachedChecklist(assignment.checklistId);
  const [answers, setAnswers] = useState({});

  const change = useCallback(
    // ponytail: in-memory only. §9 makes this write-through to expo-sqlite so a
    // killed app does not lose a half-finished inspection.
    (itemId, value) => setAnswers((prev) => ({ ...prev, [itemId]: value })),
    [],
  );

  if (!assignment) {
    return (
      <View style={[s.screen, s.pad]}>
        <Text style={s.muted}>{t('institute.notCached')}</Text>
      </View>
    );
  }
  if (!checklist) {
    return (
      <View style={[s.screen, s.pad]}>
        <Text style={s.muted}>{t('inspect.noChecklist')}</Text>
      </View>
    );
  }

  const progress = countAnswered(checklist, answers);
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Text style={s.h1}>{assignment.institute.name}</Text>
      <Text style={s.muted}>{t('inspect.answered', progress)}</Text>
      <Checklist checklist={checklist} answers={answers} onChange={change} />
    </ScrollView>
  );
}
