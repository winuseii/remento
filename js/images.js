// Card images: compress, upload, and hand back a signed URL.
// The bucket is private, so nothing here ever produces a public link.

import { supabase } from './supabase.js';
import { IMAGE_BUCKET, DEFAULTS } from './config.js';

/**
 * Shrink a File to WebP before it leaves the device.
 * Longest edge 1600 px at quality 0.82 puts a slide screenshot at 120-180 KB,
 * which is what makes 1 GB of free storage hold roughly 6,000 images.
 */
export async function compressImage(file, opts = {}) {
  const { maxEdge, type, quality } = { ...DEFAULTS.image, ...opts };
  const bitmap = await createImageBitmap(file);

  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image compression failed'))),
      type, quality);
  });
  return { blob, width: w, height: h };
}

/** Upload one image for a card. Returns the row to push into cards.images. */
export async function uploadImage(file, cardId) {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) throw new Error('Not signed in');

  const { blob, width, height } = await compressImage(file);
  const path = `${auth.user.id}/${cardId}/${crypto.randomUUID()}.webp`;

  const { error } = await supabase.storage.from(IMAGE_BUCKET)
    .upload(path, blob, { contentType: 'image/webp', upsert: false });
  if (error) throw new Error(error.message);

  return { path, w: width, h: height, bytes: blob.size };
}

const urlCache = new Map();

/** A signed URL for a stored path, cached until shortly before it expires. */
export async function signedImageUrl(path, ttl = 3600) {
  const hit = urlCache.get(path);
  if (hit && hit.expires > Date.now()) return hit.url;

  const { data, error } = await supabase.storage.from(IMAGE_BUCKET)
    .createSignedUrl(path, ttl);
  if (error) throw new Error(error.message);

  urlCache.set(path, { url: data.signedUrl, expires: Date.now() + (ttl - 60) * 1000 });
  return data.signedUrl;
}

export async function deleteImages(paths) {
  if (!paths?.length) return;
  const { error } = await supabase.storage.from(IMAGE_BUCKET).remove(paths);
  if (error) throw new Error(error.message);
}
