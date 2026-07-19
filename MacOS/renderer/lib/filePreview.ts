/* Pure file-preview classifier — decides HOW a file opened as a Workspace tab
   should be shown (inline media vs. source vs. a truthful metadata fallback)
   based on its name/extension. Kept dependency-free + unit-tested so the
   FileViewer's branching logic stays honest about what WebKit can actually
   render inline. */

export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'binary';

const VIDEO = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv']);
const AUDIO = new Set(['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'flac']);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif']);
const TEXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'json5',
  'md', 'markdown', 'mdx', 'txt', 'text', 'log', 'csv', 'tsv',
  'css', 'scss', 'sass', 'less', 'html', 'htm', 'xml', 'svg-src',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat',
  'py', 'rb', 'go', 'rs', 'swift', 'java', 'kt', 'kts', 'c', 'h', 'cc',
  'cpp', 'hpp', 'cs', 'php', 'sql', 'graphql', 'gql', 'proto', 'lua',
  'r', 'jl', 'dart', 'ex', 'exs', 'erl', 'clj', 'scala', 'vue', 'svelte',
  'dockerfile', 'gitignore', 'gitattributes', 'editorconfig', 'lock',
]);

/** Lowercased extension of a filename or path (no leading dot). '' when none. */
function extOf(nameOrPath: string): string {
  const base = (nameOrPath.split(/[\\/]/).pop() ?? nameOrPath).toLowerCase();
  if (base === 'dockerfile' || base === '.gitignore' || base === '.gitattributes' || base === '.editorconfig') {
    return base.replace(/^\./, '');
  }
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1) : '';
}

/** Classify a file by extension into a coarse preview kind. */
export function previewKind(nameOrPath: string): PreviewKind {
  const e = extOf(nameOrPath);
  if (!e) return 'binary';
  if (VIDEO.has(e)) return 'video';
  if (AUDIO.has(e)) return 'audio';
  if (IMAGE.has(e)) return 'image';
  if (e === 'pdf') return 'pdf';
  if (TEXT.has(e)) return 'text';
  return 'binary';
}

/* Video containers WebKit's <video> element cannot demux/play regardless of
   codec (no MSE fallback in the app shell). mkv is the common offender. */
const NON_INLINE_VIDEO = new Set(['mkv']);

/** Whether WebKit's built-in elements can render this file inline. Honest — a
    truthful `false` routes the FileViewer to a metadata/open-externally panel
    instead of a broken <video>/<embed>.

    NOTE: even for "inline" video (mp4/m4v/mov/webm) WebKit only decodes codecs
    the OS supports — H.264/AAC play; an H.265/HEVC or AV1 track in an .mp4 may
    still show a black frame. We can't know the codec from the name, so we
    optimistically inline the container and let the <video> surface its own
    error; the metadata fallback stays one click away. */
export function webkitCanInline(kind: PreviewKind, name: string): boolean {
  switch (kind) {
    case 'image':
      // SVG is an active document type — the stream route serves it INERT for safety,
      // so it can't be inlined via <img>. Route it to the metadata fallback instead.
      return extOf(name) !== 'svg';
    case 'pdf':
    case 'audio':
      return true;
    case 'video':
      return !NON_INLINE_VIDEO.has(extOf(name));
    // text is rendered by the source view, not as inline media.
    case 'text':
    case 'binary':
    default:
      return false;
  }
}

/** The honest reason a media file isn't shown inline, for the fallback panel.
 *  A decode/load failure (the <video>/<audio>/<img> fired onError) is the most
 *  important case: a supported CONTAINER can still hold a codec WebKit can't
 *  decode, so we tell the truth and point at the default app. */
export function mediaFallbackReason(opts: { streamUrl: string | null; decodeFailed: boolean }): string {
  if (opts.decodeFailed) return 'WebKit couldn’t decode this media; open it with the default app.';
  if (!opts.streamUrl) return 'Inline preview needs the desktop app.';
  return 'This file type can’t be previewed inline here.';
}

/** Human-friendly byte count ("512 B", "1.5 KB", "3 MB"). Lean decimals. */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const s = (v >= 10 ? v.toFixed(0) : v.toFixed(1)).replace(/\.0$/, '');
  return `${s} ${units[i]}`;
}
