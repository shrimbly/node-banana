/**
 * Poster thumbnails extracted from videos (Output Gallery tiles, Video Stitch
 * clips), kept by the video's source for the session. A node mounted again
 * (on the GPU canvas a painted copy, then the live node) shows the poster in
 * its first render instead of extracting it again.
 */
export interface VideoPoster {
  thumbnail: string;
  duration: number | null;
}

const MAX_ENTRIES = 60;
const posters = new Map<string, VideoPoster>();

export function videoPoster(src: string): VideoPoster | undefined {
  return posters.get(src);
}

export function rememberVideoPoster(src: string, poster: VideoPoster) {
  posters.delete(src);
  posters.set(src, poster);
  while (posters.size > MAX_ENTRIES) {
    const oldest = posters.keys().next().value;
    if (oldest === undefined) break;
    posters.delete(oldest);
  }
}
