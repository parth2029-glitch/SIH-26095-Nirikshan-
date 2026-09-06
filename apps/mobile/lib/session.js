import * as SecureStore from 'expo-secure-store';
import * as Device from 'expo-device';
import * as Crypto from 'expo-crypto';

const TOKEN = 'nirikshan.token';
const USER = 'nirikshan.user';
const DEVICE_ID = 'nirikshan.deviceId';
const HMAC_KEY = 'nirikshan.deviceHmacKey';

/**
 * A stable per-install id. The server derives §8's HMAC key from (user, device),
 * so this must survive app restarts — hence SecureStore rather than a module
 * variable. `Device.osBuildId` is not unique per install and cannot be used.
 */
export async function deviceId() {
  const existing = await SecureStore.getItemAsync(DEVICE_ID);
  if (existing) return existing;
  const fresh = Crypto.randomUUID();
  await SecureStore.setItemAsync(DEVICE_ID, fresh);
  return fresh;
}

/**
 * `deviceHmacKey` comes back once, at login, and is never re-fetchable
 * (docs/API.md). Losing it means logging in again, so it goes to the keystore
 * in the same breath as the token — §8 signs reports with it.
 */
export async function save({ token, user, deviceHmacKey }) {
  await SecureStore.setItemAsync(TOKEN, token);
  await SecureStore.setItemAsync(USER, JSON.stringify(user));
  if (deviceHmacKey) await SecureStore.setItemAsync(HMAC_KEY, deviceHmacKey);
}

export const token = () => SecureStore.getItemAsync(TOKEN);
export const hmacKey = () => SecureStore.getItemAsync(HMAC_KEY);

export async function user() {
  const raw = await SecureStore.getItemAsync(USER);
  return raw ? JSON.parse(raw) : null;
}

export async function clear() {
  // deviceId survives a logout on purpose: it identifies the handset, not the
  // person, and re-deriving the same HMAC key on the next login is the point.
  await Promise.all([TOKEN, USER, HMAC_KEY].map((k) => SecureStore.deleteItemAsync(k)));
}

/** Model name for §8's device signals; harmless to read here. */
export const deviceLabel = () => `${Device.manufacturer ?? '?'} ${Device.modelName ?? '?'}`.trim();
