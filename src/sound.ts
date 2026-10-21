/**
 * The optional completion sound.
 *
 * The sound is one short, original two-note chime that is bundled with the
 * application. It is never looped and never scheduled: a phase completion is
 * a single event, so a failing audio device can only make that one event
 * quiet. Nothing here throws into the timer.
 */
import completionChimeUrl from "./assets/completion.wav?url";

/** The bundled asset. Vite copies it next to the application bundle. */
export const COMPLETION_CHIME_URL = completionChimeUrl;

export interface ChimeOptions {
  /** The document that owns the media element. */
  document?: Document;
  /**
   * Create the media element. Tests inject a stub so that no audio device is
   * needed; the application uses an ordinary `HTMLAudioElement`.
   */
  createAudio?: () => HTMLAudioElement;
}

/**
 * Turn a stored volume (0 to 100) into the gain of a media element.
 *
 * A missing, negative or unreadable value is silent rather than loud.
 */
export function chimeGain(volumePercent: number): number {
  if (!Number.isFinite(volumePercent)) {
    return 0;
  }
  return Math.min(100, Math.max(0, volumePercent)) / 100;
}

/**
 * Play the completion chime once.
 *
 * Returns true when playback was attempted. Playback is best effort: a denied
 * autoplay request or a missing audio device is swallowed, because the visual
 * completion is the authoritative signal.
 */
export function playCompletionChime(
  volumePercent: number,
  options: ChimeOptions = {}
): boolean {
  const gain = chimeGain(volumePercent);
  if (gain <= 0) {
    return false;
  }
  try {
    const audio = options.createAudio ? options.createAudio() : createElement(options);
    audio.src = COMPLETION_CHIME_URL;
    audio.loop = false;
    audio.preload = "auto";
    audio.volume = gain;
    const playback = audio.play();
    if (playback && typeof playback.catch === "function") {
      // Some engines return a promise, older ones return nothing.
      playback.catch(() => undefined);
    }
    return true;
  } catch {
    return false;
  }
}

function createElement(options: ChimeOptions): HTMLAudioElement {
  const doc = options.document ?? (typeof document === "undefined" ? null : document);
  if (!doc) {
    throw new Error("There is no document to create the completion sound with.");
  }
  return doc.createElement("audio");
}
