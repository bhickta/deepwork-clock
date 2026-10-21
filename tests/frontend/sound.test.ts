// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { chimeGain, COMPLETION_CHIME_URL, playCompletionChime } from "../../src/sound";

interface FakeAudio {
  src: string;
  loop: boolean;
  preload: string;
  volume: number;
  play: ReturnType<typeof vi.fn>;
}

function fakeAudio(play: ReturnType<typeof vi.fn> = vi.fn(async () => undefined)): FakeAudio {
  return { src: "", loop: true, preload: "", volume: 1, play };
}

describe("completion chime", () => {
  it("turns the stored volume into a bounded gain", () => {
    expect(chimeGain(0)).toBe(0);
    expect(chimeGain(60)).toBe(0.6);
    expect(chimeGain(100)).toBe(1);
    expect(chimeGain(150)).toBe(1);
    expect(chimeGain(-20)).toBe(0);
    expect(chimeGain(Number.NaN)).toBe(0);
  });

  it("plays the bundled asset once at the requested volume", () => {
    const audio = fakeAudio();
    const played = playCompletionChime(60, {
      createAudio: () => audio as unknown as HTMLAudioElement
    });

    expect(played).toBe(true);
    expect(audio.src).toBe(COMPLETION_CHIME_URL);
    expect(audio.src).toContain("completion.wav");
    expect(audio.loop).toBe(false);
    expect(audio.volume).toBe(0.6);
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it("does not touch the audio device at volume zero", () => {
    const createAudio = vi.fn();

    expect(playCompletionChime(0, { createAudio })).toBe(false);
    expect(createAudio).not.toHaveBeenCalled();
  });

  it("swallows a refused playback", async () => {
    const audio = fakeAudio(vi.fn(async () => Promise.reject(new Error("blocked"))));

    expect(playCompletionChime(30, { createAudio: () => audio as unknown as HTMLAudioElement })).toBe(
      true
    );
    // The rejection is handled by the module, so nothing escapes to the app.
    await Promise.resolve();
  });

  it("swallows a broken audio device", () => {
    expect(
      playCompletionChime(30, {
        createAudio: () => {
          throw new Error("no audio device");
        }
      })
    ).toBe(false);
  });
});
