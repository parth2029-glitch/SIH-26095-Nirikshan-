import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { cachedAssignment, cachedChecklist } from '../../lib/api.js';
import { draftFor, enqueue, evidenceFor, saveAnswers, saveEvidence } from '../../lib/db.js';
import { deviceSignals, gpsSeries } from '../../lib/capture.js';
import { signReport } from '../../lib/sign.js';
import * as session from '../../lib/session.js';
import * as sync from '../../lib/sync.js';
import Checklist, { countAnswered } from '../../components/Checklist.jsx';
import { t } from '../../lib/i18n.js';
import { s } from '../../lib/styles.js';

export default function Inspect() {
  const { id } = useLocalSearchParams();
  const assignment = cachedAssignment(id);
  const checklist = assignment && cachedChecklist(assignment.checklistId);

  const [draft, setDraft] = useState(null);
  const [answers, setAnswers] = useState({});
  const [evidence, setEvidence] = useState({});
  const [submitting, setSubmitting] = useState(false);

  // The draft is loaded from SQLite, not created fresh: a killed app reopens on
  // the answers it already had, under the same clientId (§9).
  useEffect(() => {
    if (!assignment) return;
    draftFor(id).then(async (row) => {
      setDraft(row);
      setAnswers(row.answers);
      const stored = await evidenceFor(row.clientId);
      setEvidence(Object.fromEntries(stored.map((item) => [item.itemId, item])));
    });
  }, [assignment, id]);

  const change = useCallback(
    (itemId, value) => {
      setAnswers((prev) => {
        const next = { ...prev, [itemId]: value };
        // Write-through, not on-submit: an inspection that survives a battery
        // pull is the whole point of doing this offline-first.
        if (draft) saveAnswers(draft.clientId, next);
        return next;
      });
    },
    [draft],
  );

  const capture = useCallback(
    (item) => {
      setEvidence((prev) => ({ ...prev, [item.itemId]: item }));
      if (draft) saveEvidence(draft.clientId, item);
    },
    [draft],
  );

  const submit = useCallback(async () => {
    setSubmitting(true);
    try {
      const key = await session.hmacKey();
      if (!key) throw new Error(t('inspect.noKey'));

      const report = {
        clientId: draft.clientId,
        assignmentId: id,
        submittedAt: new Date().toISOString(),
        capturedOffline: true,
        answers: Object.entries(answers).map(([questionId, value]) => ({ questionId, value })),
        deviceSignals: await deviceSignals(await session.deviceId()),
        // The series is taken at submit as well as at capture: L5 compares
        // consecutive submissions, and a photo's fix answers a different
        // question from "where was this filled in".
        gpsSeries: await gpsSeries(),
        evidenceClientIds: Object.values(evidence).map((item) => item.clientId),
      };
      // Signed before it is queued, so what the outbox stores is what the
      // server verifies — a queued report cannot be edited into something else.
      await enqueue(draft.clientId, { ...report, signature: await signReport(report, key) });
      sync.drain().catch(() => {});
      router.replace('/inbox');
    } catch (err) {
      Alert.alert(t('inspect.submitFailed'), err.message);
    } finally {
      setSubmitting(false);
    }
  }, [answers, draft, evidence, id]);

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
  const complete = progress.done === progress.total;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Text style={s.h1}>{assignment.institute.name}</Text>
      <Text style={s.muted}>{t('inspect.answered', progress)}</Text>
      <Checklist
        checklist={checklist}
        answers={answers}
        evidence={evidence}
        onChange={change}
        onCapture={capture}
      />
      <Pressable
        style={[s.button, (!complete || submitting || !draft) && s.buttonDisabled]}
        disabled={!complete || submitting || !draft}
        onPress={submit}
      >
        <Text style={s.buttonText}>{t(submitting ? 'inspect.submitting' : 'inspect.submit')}</Text>
      </Pressable>
      <Text style={s.muted}>{t('inspect.queuedHint')}</Text>
    </ScrollView>
  );
}
