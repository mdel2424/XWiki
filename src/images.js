// Wikimedia thumbnails can fail even when their original PNG/GIF is available.
export function originalImage(source) {
  try {
    const url = new URL(source);
    if (url.protocol !== 'https:' || url.hostname !== 'upload.wikimedia.org') return null;
    const match = url.pathname.match(/^\/wikipedia\/([^/]+)\/thumb\/([^/]+)\/([^/]+)\/([^/]+)\/.+$/);
    if (!match || !/\.(png|gif|jpe?g|webp|svg|avif)$/i.test(decodeURIComponent(match[4]))) return null;
    url.pathname = `/wikipedia/${match[1]}/${match[2]}/${match[3]}/${match[4]}`;
    url.search = ''; url.hash = '';
    return url.href;
  } catch { return null; }
}

const failed = new Map();
export function imageSource(source) { return failed.has(source) ? imageSource(failed.get(source)) : source; }
export function recoverImage(image) {
  const source = image.dataset.originalSrc || image.src;
  const fallback = failed.has(source) ? null : originalImage(source);
  failed.set(source, fallback);
  if (fallback) {
    image.dataset.originalSrc = source;
    image.src = fallback;
  } else image.closest('.article-media')?.remove();
}
