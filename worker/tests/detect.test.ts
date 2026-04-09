import { describe, expect, it } from "vitest";
import type { AppleTrack } from "../src/env";
import { detectPlays } from "../src/detect";

function track(id: string): AppleTrack {
  return {
    id,
    name: id,
    artist: "artist",
    album: "album",
    duration_ms: 180_000,
  };
}

describe("detectPlays", () => {
  it("X played twice in a row", () => {
    const previous = [track("A"), track("B"), track("C")];
    const current = [track("X"), track("X"), ...previous];

    const plays = detectPlays(current, previous);

    expect(plays).toHaveLength(2);
    expect(plays.map((p) => p.kind)).toEqual(["new", "new"]);
    expect(plays.map((p) => p.track.id)).toEqual(["X", "X"]);
  });

  it("X played three times in a row", () => {
    const previous = [track("A"), track("B"), track("C")];
    const current = [track("X"), track("X"), track("X"), ...previous];

    const plays = detectPlays(current, previous);

    expect(plays).toHaveLength(3);
    expect(plays.map((p) => p.kind)).toEqual(["new", "new", "new"]);
    expect(plays.map((p) => p.track.id)).toEqual(["X", "X", "X"]);
  });

  it("D then X then X again", () => {
    const previous = [track("A"), track("B"), track("C")];
    const current = [track("X"), track("X"), track("D"), ...previous];

    const plays = detectPlays(current, previous);

    expect(plays).toHaveLength(3);
    expect(plays.map((p) => `${p.kind} ${p.track.id}`)).toEqual([
      "new D",
      "new X",
      "new X",
    ]);
  });

  it("repeat via fallback", () => {
    const previous = [track("X"), track("A"), track("B")];
    const current = [track("A"), track("X"), track("B")];

    const plays = detectPlays(current, previous);

    expect(plays).toHaveLength(1);
    expect(plays[0].kind).toBe("repeat");
    expect(plays[0].track.id).toBe("A");
  });

  it("idle: same list twice", () => {
    const previous = [track("A"), track("B"), track("C")];
    const current = [track("A"), track("B"), track("C")];

    const plays = detectPlays(current, previous);

    expect(plays).toEqual([]);
  });

  it("first run with empty previous", () => {
    const previous: AppleTrack[] = [];
    const current = [track("A"), track("B"), track("C")];

    const plays = detectPlays(current, previous);

    expect(plays).toHaveLength(3);
    expect(plays.map((p) => p.kind)).toEqual(["new", "new", "new"]);
    expect(plays.map((p) => p.track.id)).toEqual(["C", "B", "A"]);
  });
});
