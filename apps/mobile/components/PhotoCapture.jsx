import { useRef, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { evidenceFromPhoto } from '../lib/capture.js';
import { t } from '../lib/i18n.js';
import { colour, s } from '../lib/styles.js';

/**
 * The only way an image enters this app (§8, PRD F2).
 *
 * A full-screen `CameraView` and nothing else: no gallery button, no picker, no
 * `expo-image-picker` in the dependency tree, and the media-library permissions
 * are in `blockedPermissions` in app.json so the OS would refuse anyway. An
 * inspector photographs what is in front of them or submits no photograph.
 */
export default function PhotoCapture({ item, evidence, onCaptured }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef(null);

  const shoot = async () => {
    setBusy(true);
    try {
      // base64 because the SHA-256 has to be over the bytes that get uploaded,
      // and there is no file-read API in this dependency set.
      const photo = await camera.current?.takePictureAsync({ quality: 0.8, base64: true });
      if (photo) onCaptured(await evidenceFromPhoto(photo, item.id));
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const openCamera = async () => {
    if (!permission?.granted && !(await requestPermission()).granted) return;
    setOpen(true);
  };

  return (
    <View style={{ gap: 8 }}>
      {evidence ? (
        <View style={{ gap: 6 }}>
          <Image source={{ uri: evidence.uri }} style={{ height: 160, borderRadius: 8 }} />
          <Text style={s.muted}>{t('inspect.photoHash', { hash: evidence.sha256.slice(0, 12) })}</Text>
          {evidence.location?.mocked ? <Text style={s.danger}>{t('inspect.photoMocked')}</Text> : null}
        </View>
      ) : null}

      <Pressable style={s.button} onPress={openCamera}>
        <Text style={s.buttonText}>{t(evidence ? 'inspect.retake' : 'inspect.takePhoto')}</Text>
      </Pressable>

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <CameraView ref={camera} style={{ flex: 1 }} facing="back" />
        <View style={[s.pad, { backgroundColor: colour.card }]}>
          {busy ? <ActivityIndicator /> : null}
          <Pressable style={[s.button, busy && s.buttonDisabled]} disabled={busy} onPress={shoot}>
            <Text style={s.buttonText}>{t(busy ? 'inspect.hashing' : 'inspect.shutter')}</Text>
          </Pressable>
          <Pressable onPress={() => setOpen(false)}>
            <Text style={[s.muted, { textAlign: 'center' }]}>{t('inspect.cancel')}</Text>
          </Pressable>
        </View>
      </Modal>
    </View>
  );
}
