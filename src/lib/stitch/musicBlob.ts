/**
 * The music as a Stitch decodes it: fetched to a Blob that carries a type
 * (the response's, else the data: URL's, else MP3), ready for
 * prepareAudioAsync(blob, 0). The executor (stitchInputs) and the editor's
 * waveform (waveformCache) both read it here, so the waveform drawn is the
 * music encoded.
 */
export async function fetchMusicBlob(url: string): Promise<Blob> {
  const response = await fetch(url);
  const raw = await response.blob();
  if (raw.type) return raw;
  const mime = url.startsWith("data:") ? url.split(";")[0].split(":")[1] : "audio/mpeg";
  return new Blob([raw], { type: mime });
}
