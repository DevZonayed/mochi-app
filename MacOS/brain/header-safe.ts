/* The shared credential ByteString guard.

   WHATWG HTTP header values are ByteStrings: every code unit must be <= 0xFF
   (255). Electron's `safeStorage.decryptString` (and the WebKit sidecar's
   passthrough shim decoding a real-Keychain ciphertext byte-for-byte as UTF-8)
   can "succeed" yet return mojibake containing U+FFFD (65533) replacement
   chars when the stored bytes were written under a DIFFERENT app signature.
   The moment such a string reaches `fetch`'s `Headers` (e.g. `authorization:
   Key <apiKey>`) it throws a cryptic native "Cannot convert argument to a
   ByteString because the character at index N has a value of 65533 which is
   greater than 255." — the exact production FAL failure.

   Every provider path that builds an authorization header must reject a
   non-header-safe secret up front so that native TypeError can never surface;
   the user gets an actionable "reconnect" message instead. Pure + dependency
   free so it can be shared by the credential store AND the media engine
   without dragging Electron into either's unit tests.

   "Header-safe" means every code unit is a valid HTTP header-value byte:
     • > 0xFF (255)  → U+FFFD mojibake etc. → the classic ByteString TypeError.
     • NUL / CR / LF → undici throws a DIFFERENT native "Invalid header value"
       TypeError; a real API key never contains them, so rejecting them here
       keeps the guarantee "a corrupt credential yields an actionable message,
       never a native TypeError" airtight. */
export function isHeaderSafeSecret(s: unknown): s is string {
  if (typeof s !== 'string' || s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0xff || c === 0x00 || c === 0x0a || c === 0x0d) return false;
  }
  return true;
}

/** A pasteable API credential / bot token: one or more PRINTABLE ASCII bytes
    (0x21–0x7E) — no spaces or TAB, no control chars, no DEL (0x7F), no extended
    Latin-1, no non-ASCII, no U+FFFD. Real FAL / Anthropic / OpenAI / GitHub /
    bot tokens are all printable ASCII, so this is the correct STORE/CONNECT
    policy: it is strictly tighter than isHeaderSafeSecret (which only guarantees
    a value is a legal HTTP header byte-string). Used to validate a key on
    connect and to gate one-time migration of a legacy stored credential. Outer
    whitespace/BOM must be trimmed by the caller BEFORE this check; interior
    bytes are never mutated. */
export function isStrictAsciiSecret(s: unknown): s is string {
  return typeof s === 'string' && /^[\x21-\x7E]+$/.test(s);
}
