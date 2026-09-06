import { StyleSheet } from 'react-native';

export const colour = {
  bg: '#f6f7f9',
  card: '#ffffff',
  line: '#dcdfe4',
  text: '#16181d',
  muted: '#606672',
  accent: '#1f5fbf',
  danger: '#b3261e',
  on: '#1f5fbf',
};

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colour.bg },
  pad: { padding: 16, gap: 12 },
  h1: { fontSize: 22, fontWeight: '700', color: colour.text },
  h2: { fontSize: 16, fontWeight: '700', color: colour.text },
  label: { fontSize: 14, color: colour.muted },
  body: { fontSize: 15, color: colour.text },
  muted: { fontSize: 13, color: colour.muted },
  danger: { fontSize: 14, color: colour.danger },
  card: {
    backgroundColor: colour.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colour.line,
    padding: 14,
    gap: 6,
  },
  input: {
    backgroundColor: colour.card,
    borderWidth: 1,
    borderColor: colour.line,
    borderRadius: 8,
    paddingHorizontal: 12,
    // Android centres text in a short box without this.
    paddingVertical: 10,
    fontSize: 16,
    color: colour.text,
  },
  button: {
    backgroundColor: colour.accent,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonText: { color: '#ffffff', fontSize: 16, fontWeight: '600' },
  buttonDisabled: { opacity: 0.5 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: colour.line,
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: colour.card,
  },
  chipOn: { backgroundColor: colour.on, borderColor: colour.on },
  chipText: { fontSize: 14, color: colour.text },
  chipTextOn: { color: '#ffffff', fontWeight: '600' },
});
