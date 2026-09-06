import { Pressable, Text, TextInput, View } from 'react-native';
import PhotoCapture from './PhotoCapture.jsx';
import { localised, t } from '../lib/i18n.js';
import { s } from '../lib/styles.js';

const Chip = ({ label, on, onPress }) => (
  <Pressable
    style={[s.chip, on && s.chipOn]}
    onPress={onPress}
    accessibilityRole="radio"
    accessibilityState={{ selected: on }}
  >
    <Text style={[s.chipText, on && s.chipTextOn]}>{label}</Text>
  </Pressable>
);

/**
 * One checklist item. Every scheme's questionnaire is the same five shapes, so
 * the renderer switches on `type` and the JSON decides everything else — adding
 * a scheme is a file in `apps/api/checklists/`, never a change here.
 */
function Item({ item, value, evidence, onChange, onCapture }) {
  const set = (next) => onChange(item.id, next);

  const control = {
    bool: () => (
      <View style={s.chipRow}>
        <Chip label={t('inspect.yes')} on={value === true} onPress={() => set(true)} />
        <Chip label={t('inspect.no')} on={value === false} onPress={() => set(false)} />
      </View>
    ),
    number: () => (
      <TextInput
        style={s.input}
        keyboardType="number-pad"
        value={value === undefined || value === null ? '' : String(value)}
        // Empty box means unanswered, not zero — the difference matters when a
        // headcount is the finding.
        onChangeText={(text) => set(text === '' ? undefined : Number(text.replace(/\D/g, '')))}
      />
    ),
    text: () => <TextInput style={s.input} multiline value={value ?? ''} onChangeText={set} />,
    choice: () => (
      <View style={s.chipRow}>
        {item.options.map((option) => (
          <Chip
            key={option.value}
            label={localised(option.label)}
            on={value === option.value}
            onPress={() => set(option.value)}
          />
        ))}
      </View>
    ),
    // The answer value is the evidence's clientId, so a photographed item
    // counts as answered by the same rule as every other type.
    photo: () => (
      <PhotoCapture
        item={item}
        evidence={evidence}
        onCaptured={(captured) => {
          onCapture(captured);
          set(captured.clientId);
        }}
      />
    ),
  }[item.type];

  return (
    <View style={s.card}>
      <Text style={s.body}>{localised(item.label)}</Text>
      {control ? control() : <Text style={s.danger}>Unsupported item type: {item.type}</Text>}
    </View>
  );
}

/** JSON in, form out. `answers` is a flat `{ [itemId]: value }` map. */
export default function Checklist({ checklist, answers, evidence = {}, onChange, onCapture }) {
  return checklist.sections.map((section) => (
    <View key={section.id} style={{ gap: 12 }}>
      <Text style={s.h2}>{localised(section.title)}</Text>
      {section.items.map((item) => (
        <Item
          key={item.id}
          item={item}
          value={answers[item.id]}
          evidence={evidence[item.id]}
          onChange={onChange}
          onCapture={onCapture}
        />
      ))}
    </View>
  ));
}

/** Answered = anything but `undefined`; `false` and `0` are real answers. */
export const countAnswered = (checklist, answers) =>
  checklist.sections
    .flatMap((section) => section.items)
    .reduce(
      (acc, item) => {
        acc.total += 1;
        if (answers[item.id] !== undefined) acc.done += 1;
        return acc;
      },
      { done: 0, total: 0 },
    );
