/* Attachment store — one place on disk for every composer attachment the user
   adds to a chat message (pasted image, pasted text, picked/dropped file).

   Location: `<projectCwd>/.continuum/Attachment/<safeName>_<idSuffix>.<ext>`,
   right next to `.continuum/STATE.md` so attachments travel with the project's
   memory (move/clone the project → its attachments move with it).

   Each save returns the absolute path on this Mac. The composer embeds that
   path as `@<absPath>` inline at the chip position, so the agent sees the
   reference at the exact spot the user typed it AND can `Read` the file with
   its standard tools. The path is the source of truth — no URL scheme, no
   protocol handler, no second copy. */

import { existsSync, mkdirSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Filename charset: keep it boring so a real file on disk doesn't surprise the
    agent (or a future `ls`). */
const SAFE_NAME = /[^a-zA-Z0-9._-]+/g;
const TRAILING_DOTS = /^\.+|\.+$/g;

function safeBase(name: string): string {
  const trimmed = (name || '').replace(SAFE_NAME, '_').replace(TRAILING_DOTS, '').slice(0, 80);
  return trimmed || 'attachment';
}

/** Take the random suffix of a composer-style id like '1734550000-abc12' → 'abc12'.
    Falls back to a fresh suffix when the id is missing/empty. */
function suffixOf(id: string): string {
  const raw = (id ?? '').toString();
  const tail = raw.includes('-') ? raw.split('-').pop()! : raw;
  const cleaned = tail.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
  return cleaned || Math.random().toString(36).slice(2, 8);
}

function extFromName(name: string, fallback = ''): string {
  const e = (path.extname(name || '').slice(1) || fallback).toLowerCase();
  // Normalize the common photo extension drift so identical bytes deduplicate.
  return e === 'jpeg' ? 'jpg' : e;
}

/** Turn a git branch (`mochi/<city>/<slug>`) into ONE safe folder segment so
    every attachment for a chat lives under its own branch-named subfolder:
    `.continuum/Attachment/<branchSlug>/<file>`. Empty input → '' (flat layout,
    backward-compatible with attachments saved before per-branch folders). */
function branchFolder(branch?: string): string {
  const raw = (branch ?? '').trim();
  if (!raw) return '';
  // Slashes in the branch become dashes (one folder, not a nested tree); then
  // strip anything that isn't filesystem-boring so the folder is always safe.
  const slug = raw.replace(/[\/\\]+/g, '-').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 64);
  return slug;
}

/** The canonical attachments directory for a project. When `branch` is given,
    attachments are scoped under a branch-named subfolder
    (`.continuum/Attachment/<branchSlug>/`) so each chat's pastes/files are
    grouped together. Created if missing. */
export function attachmentsDirFor(projectCwd: string, branch?: string): string {
  const folder = branchFolder(branch);
  const dir = folder
    ? path.join(projectCwd, '.continuum', 'Attachment', folder)
    : path.join(projectCwd, '.continuum', 'Attachment');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export type AttachmentKind = 'image' | 'text' | 'file' | 'ref';

export interface SaveAttachmentInput {
  /** Composer-side id (the chip's id). Used to derive the filename suffix AND as
      the substitution key for the inline `@<path>` placeholder. */
  id: string;
  kind: AttachmentKind;
  /** Original filename — for display + the saved file's basename. */
  name: string;
  /** image / file: raw bytes. */
  bytes?: Buffer;
  /** text: the pasted text content. Saved as a `.txt` file. */
  content?: string;
  /** ref: an existing on-disk path the user dragged in. Copied into the
      attachments folder so every attachment lives in ONE place. */
  srcPath?: string;
  /** Optional mime — only used to fall back on an extension when `name` is bare. */
  mime?: string;
  /** Optional chat branch (or codename). When set, the file is saved under a
      branch-named subfolder (`.continuum/Attachment/<branchSlug>/`) so each
      chat's attachments are grouped together. Omit for the legacy flat layout. */
  branch?: string;
}

export interface SavedAttachment {
  id: string;
  /** Absolute path on this Mac — what gets embedded as `@<absPath>`. */
  absPath: string;
  /** Final saved basename (display + relay-safe). */
  name: string;
  kind: AttachmentKind;
  /** Byte size of the saved file (for the bubble's small "12 KB" subtitle). */
  bytes: number;
  /** Always set for image kind so the relay snapshot can still describe it. */
  mime?: string;
}

function fallbackExtForMime(mime?: string): string {
  if (!mime) return 'bin';
  const m = mime.toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  if (m.includes('svg')) return 'svg';
  if (m.includes('pdf')) return 'pdf';
  if (m.includes('json')) return 'json';
  if (m.includes('text') || m.includes('plain')) return 'txt';
  return 'bin';
}

/** Save one composer attachment under the project's `.continuum/Attachment/`.
    The returned `absPath` is what callers embed inline as `@<absPath>` at the
    chip position; the bytes also live at that path for the agent's `Read` tool.

    Idempotent on the SAME id: re-saving the same id rewrites the same file
    (same suffix). That keeps a user who removes-then-re-adds the same paste
    from accumulating zombie files. */
export function saveAttachment(projectCwd: string, input: SaveAttachmentInput): SavedAttachment {
  if (!projectCwd) throw new Error('attachments: projectCwd required');
  const dir = attachmentsDirFor(projectCwd, input.branch);
  const suffix = suffixOf(input.id);
  const baseName = safeBase(path.basename(input.name || '', path.extname(input.name || '')));
  // Pick the extension: prefer the original filename, then the mime, then a
  // sensible default per kind.
  const kindDefault = input.kind === 'image' ? 'png' : input.kind === 'text' ? 'txt' : 'bin';
  const ext = extFromName(input.name || '', fallbackExtForMime(input.mime) || kindDefault) || kindDefault;
  const finalName = `${baseName}_${suffix}.${ext}`;
  const absPath = path.join(dir, finalName);

  if (input.kind === 'text') {
    const content = input.content ?? '';
    writeFileSync(absPath, content, 'utf8');
  } else if (input.kind === 'ref' && input.srcPath && existsSync(input.srcPath)) {
    // Copy the referenced file into the attachments folder so every attachment
    // lives in ONE place. The user's original on-disk file is untouched.
    copyFileSync(input.srcPath, absPath);
  } else if (input.bytes && input.bytes.length) {
    writeFileSync(absPath, input.bytes);
  } else {
    throw new Error(`attachments: ${input.kind} attachment "${input.name}" had no bytes/content/srcPath`);
  }

  const bytes = statSync(absPath).size;
  return {
    id: input.id,
    absPath,
    name: finalName,
    kind: input.kind,
    bytes,
    ...(input.mime ? { mime: input.mime } : {}),
  };
}

/** The placeholder the composer chip serializes to. The backend substitutes
    each occurrence for `@<absPath>` once the attachment is saved. */
export function placeholderFor(id: string): string { return `«attach:${id}»`; }

/** Replace every `«attach:<id>»` placeholder in `text` with `@${map.get(id)}`.
    Unknown ids are dropped (defensive — a stale chip with no payload shouldn't
    leave dead syntax in the prompt). */
export function substitutePlaceholders(text: string, map: Map<string, string>): string {
  if (!text || text.indexOf('«attach:') === -1) return text;
  return text.replace(/«attach:([A-Za-z0-9_-]+)»/g, (_m, id: string) => {
    const abs = map.get(id);
    return abs ? `@${abs}` : '';
  }).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

/** For the relay snapshot: rewrite every `@<absPath>` that lives under any
    `.continuum/Attachment/` directory into `@.continuum/Attachment/<subpath>`,
    so the phone/web remote never learns the operator's home directory. Path
    matching uses `[^@\n]+?` (not `[^\s]+`) so a project folder with spaces
    — eg `/Users/me/Desktop/Client Shared GIT/veni0004/` — still scrubs.
    Sub-directories under `Attachment/` (incl. a branch subfolder) are preserved
    in the scrubbed form so the relay reference still points at the same file. */
export function scrubAbsPathsForRelay(text: string): string {
  if (!text) return text;
  return text.replace(/@(\/[^@\n]+?\/\.continuum\/Attachment\/((?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.[A-Za-z0-9]+))/g,
    (_m, _full: string, base: string) => `@.continuum/Attachment/${base}`);
}

/** A standalone path token regex used by the renderer to tokenize a message
    bubble into prose + inline attachment chips. Matches both absolute paths and
    the relay-scrubbed `@.continuum/Attachment/<file>` form. Accepts spaces in
    the prefix and optional sub-directories under `Attachment/` (incl. a branch
    subfolder, `@…/Attachment/<branchSlug>/<file>`). */
export const ATTACH_PATH_TOKEN = /@((?:\/[^@\n]+?)?\.continuum\/Attachment\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.[A-Za-z0-9]+)/g;
