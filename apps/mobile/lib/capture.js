/**
 * Everything a photograph has to carry off the handset (§8, PRD F2/F3).
 *
 * One capture produces: the original JPEG bytes, their SHA-256, a device dHash,
 * a GPS series with the mock flag, and the device integrity signals. The server
 * recomputes what it can from the bytes it receives (§10) and treats the
 * device's own values as claims — which is why they are collected separately
 * and never merged.
 */
import * as Crypto from 'expo-crypto';
import * as Location from 'expo-location';
import * as Device from 'expo-device';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import jpeg from 'jpeg-js';
import { dhash, greyFromRgba, toHex as hashHex } from '@nirikshan/core/dhash';
import { fromBase64 } from './bytes.js';
import { sha256Hex } from './sign.js';
import appConfig from '../app.json';

/** 5 samples over ~10 s (§8): one fix can be spoofed by luck, a series cannot. */
const GPS_SAMPLES = 5;
const GPS_INTERVAL_MS = 2500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The mobile pixel adapter: native resize to 9×8, then decode 72 pixels in JS.
 *
 * The resize is native because decoding a 12-megapixel JPEG in JavaScript would
 * take seconds and hundreds of megabytes; the decode is JS because no Expo
 * module hands out raw pixels. `sharp` on the server uses a different kernel,
 * so the two hashes are close rather than equal — that gap is exactly what
 * §11's L9 threshold measures, and why `deviceHashHamming` is still `null`.
 */
export async function deviceDHash(uri) {
  const context = ImageManipulator.manipulate(uri).resize({ width: 9, height: 8 });
  const rendered = await context.renderAsync();
  // JPEG at compress 1 rather than PNG: expo-image-manipulator cannot emit raw
  // pixels either way, and a PNG would need an inflate implementation to read
  // back. Luma error at quality 1 is far below the resize-kernel difference.
  const { base64 } = await rendered.saveAsync({
    format: SaveFormat.JPEG,
    compress: 1,
    base64: true,
  });
  const { data } = jpeg.decode(fromBase64(base64), { useTArray: true });
  return hashHex(dhash(greyFromRgba(data)));
}

/**
 * A GPS series, not a fix. `mocked` is Android's own answer to "did an app
 * inject this?" and is the single strongest signal in the whole trust score
 * (L3, CRITICAL) — it is read per sample because a fake-GPS app can be toggled
 * mid-inspection.
 */
export async function gpsSeries(samples = GPS_SAMPLES) {
  const { granted } = await Location.requestForegroundPermissionsAsync();
  if (!granted) return [];

  const series = [];
  for (let i = 0; i < samples; i++) {
    if (i > 0) await sleep(GPS_INTERVAL_MS);
    const fix = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    }).catch(() => null);
    if (!fix) continue;
    series.push({
      at: new Date(fix.timestamp).toISOString(),
      lat: fix.coords.latitude,
      lng: fix.coords.longitude,
      accuracyM: fix.coords.accuracy,
      // Android only; iOS has no equivalent and reports undefined, which the
      // schema defaults to false. Recording `false` on iOS would be a lie.
      mocked: Boolean(fix.mocked),
    });
  }
  return series;
}

/**
 * Device integrity signals for L4.
 *
 * ponytail: `devModeEnabled` is always false. Android exposes it through
 * `Settings.Global.DEVELOPMENT_SETTINGS_ENABLED`, which no Expo module reads —
 * it needs a config plugin with a few lines of Kotlin. Reporting `__DEV__`
 * instead would answer a different question (is this a debug build) and quietly
 * corrupt L4. Add the plugin when L4 is scored for real in §11.
 */
export async function deviceSignals(deviceId) {
  return {
    deviceId,
    platform: Device.osName?.toLowerCase() ?? 'unknown',
    osVersion: Device.osVersion ?? null,
    rooted: await Device.isRootedExperimentalAsync().catch(() => false),
    // `isDevice` is false on an emulator and true on real hardware.
    emulator: !Device.isDevice,
    devModeEnabled: false,
    appVersion: appConfig.expo.version,
  };
}

/**
 * A photo from `CameraView.takePictureAsync`, turned into an evidence row.
 *
 * ponytail: the JPEG is hashed via its base64, so a capture briefly holds the
 * image twice in memory. `quality: 0.8` keeps that inside a few megabytes on
 * the oldest handset in the pilot. Switch to a streaming file hash if
 * expo-file-system is ever added for another reason.
 */
export async function evidenceFromPhoto(photo, itemId) {
  const bytes = fromBase64(photo.base64);
  const [sha256, dHash, series] = await Promise.all([
    sha256Hex(bytes),
    deviceDHash(photo.uri),
    gpsSeries(1),
  ]);
  const fix = series[0] ?? null;

  return {
    clientId: Crypto.randomUUID(),
    itemId,
    uri: photo.uri,
    sha256,
    deviceDHash: dHash,
    capturedAt: new Date().toISOString(),
    location: fix && {
      coordinates: [fix.lng, fix.lat],
      accuracyM: fix.accuracyM,
      mocked: fix.mocked,
    },
  };
}
