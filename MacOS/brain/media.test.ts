import { describe, it, expect } from 'vitest';
import { mediaModelForKind, MODELS } from './media.js';

describe('mediaModelForKind', () => {
  it('maps each agent media kind to the expected fal model key', () => {
    expect(mediaModelForKind('speech')).toBe('kokoro');
    expect(mediaModelForKind('music')).toBe('stable-audio');
    expect(mediaModelForKind('video')).toBe('kling-t2v');
    // A source still flips video to the image->video model.
    expect(mediaModelForKind('video', true)).toBe('kling-i2v');
    // ...only for video — a source image is irrelevant to speech/music.
    expect(mediaModelForKind('speech', true)).toBe('kokoro');
    expect(mediaModelForKind('music', true)).toBe('stable-audio');
  });

  it('only ever returns model keys that exist in the MODELS table', () => {
    const cases: Array<['speech' | 'music' | 'video', boolean]> = [
      ['speech', false], ['speech', true],
      ['music', false], ['music', true],
      ['video', false], ['video', true],
    ];
    for (const [kind, hasSrc] of cases) {
      const key = mediaModelForKind(kind, hasSrc);
      expect(MODELS[key], `${kind}/${hasSrc} -> ${key}`).toBeDefined();
    }
  });

  it('maps to models whose kind matches the request family', () => {
    expect(MODELS[mediaModelForKind('speech')].kind).toBe('voiceover');
    expect(MODELS[mediaModelForKind('music')].kind).toBe('audio');
    expect(MODELS[mediaModelForKind('video')].kind).toBe('video');
    expect(MODELS[mediaModelForKind('video', true)].kind).toBe('video');
  });
});
