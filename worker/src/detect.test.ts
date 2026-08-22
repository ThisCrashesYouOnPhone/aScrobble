import { describe, it, expect } from "vitest";
import { detectPlays } from "./detect";
import type { AppleTrack } from "./env";

const makeTrack = (id: string, name: string, artist = "Test Artist", duration_ms = 180000): AppleTrack => ({
  id,
  name,
  artist,
  album: "Test Album",
  duration_ms,
});

describe("detectPlays algorithm", () => {
  it("snapshots initial history on first run without duplicate scrobbles", () => {
    const current = [makeTrack("t1", "Song 1"), makeTrack("t2", "Song 2")];
    const result = detectPlays(current, [], 180, {});
    expect(result.plays).toHaveLength(2);
    expect(result.plays[0].track.id).toBe("t2");
    expect(result.plays[1].track.id).toBe("t1");
  });

  it("detects single new track via position-shift", () => {
    const previous = [makeTrack("t2", "Song 2"), makeTrack("t3", "Song 3")];
    const current = [makeTrack("t1", "Song 1"), makeTrack("t2", "Song 2"), makeTrack("t3", "Song 3")];
    const result = detectPlays(current, previous, 180, {});
    expect(result.plays).toHaveLength(1);
    expect(result.plays[0].track.id).toBe("t1");
    expect(result.plays[0].kind).toBe("new");
  });

  it("prevents false double-scrobbling on stationary position 0 when paused", () => {
    const track = makeTrack("sober", "sober", "Nettspend", 130000);
    const previous = [track];
    const current = [track];

    const poll1 = detectPlays(current, previous, 60, {});
    expect(poll1.plays).toHaveLength(0);
    expect(poll1.newState.stationaryIdle).toBe(true);

    const poll2 = detectPlays(current, previous, 120, { stationaryIdle: true });
    expect(poll2.plays).toHaveLength(0);
    expect(poll2.newState.stationaryIdle).toBe(true);
  });
});
