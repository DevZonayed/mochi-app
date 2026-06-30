import { describe, it, expect } from 'vitest';
import { looksLikeImageRequest } from './image-intent.js';

describe('looksLikeImageRequest', () => {
  it('matches explicit image-generation asks', () => {
    for (const s of [
      'generate an image of a cat on a skateboard',
      'create a logo for my coffee startup',
      'draw an icon of a gear',
      'make me a wallpaper of snowy mountains',
      'design a poster for the launch event',
      'edit this image to add a balloon in the sky',
      'a photorealistic portrait of an astronaut',
      'produce a sprite sheet for the player character',
      'render the logo',
      'picture of a sunset over the ocean',
      'image of the team standing on a rooftop',
      'illustration of a dragon guarding treasure',
    ]) {
      expect(looksLikeImageRequest(s), s).toBe(true);
    }
  });

  it('does NOT fire on "<noun> of <ui/code element>" references', () => {
    for (const s of [
      'icon of the button',
      'logo of the header',
      'image of the page',
      'thumbnail of the list row',
      'graphic of the modal component',
      'picture of the screen layout',
    ]) {
      expect(looksLikeImageRequest(s), s).toBe(false);
    }
  });

  it('does NOT fire on ordinary coding / UI asks', () => {
    for (const s of [
      'fix the React render bug',
      'make the icon render correctly',
      'the logo component is broken',
      'the icon alignment is off in the header',
      'update the avatar component props',
      'render the page after the state changes',
      'import the Image component from the library',
      'the banner css is wrong on mobile',
      'refactor the imageLoader util',
      'why does the photo upload button not work',
    ]) {
      expect(looksLikeImageRequest(s), s).toBe(false);
    }
  });
});
