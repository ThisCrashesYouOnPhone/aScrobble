import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRecentlyPlayed } from "../src/apple";

interface AppleApiItem {
  id: string;
  type: string;
  attributes: {
    name: string;
    artistName: string;
    albumName: string;
    durationInMillis: number;
  };
}

function apiItems(ids: string[]): AppleApiItem[] {
  return ids.map((id) => ({
    id,
    type: "songs",
    attributes: {
      name: `name-${id}`,
      artistName: `artist-${id}`,
      albumName: `album-${id}`,
      durationInMillis: 180_000,
    },
  }));
}

function okResponse(ids: string[]): Response {
  return new Response(JSON.stringify({ data: apiItems(ids) }), { status: 200 });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchRecentlyPlayed", () => {
  it("dedupes only a page-boundary duplicate", async () => {
    const page0 = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "X"];
    const page10 = ["X", "B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9"];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      const offset = Number(url.searchParams.get("offset") ?? "0");
      if (offset === 0) return okResponse(page0);
      if (offset === 10) return okResponse(page10);
      return okResponse([]);
    });

    const tracks = await fetchRecentlyPlayed("dev", "user");

    expect(tracks.filter((t) => t.id === "X")).toHaveLength(1);
    expect(tracks).toHaveLength(19);
  });

  it("preserves genuine consecutive duplicates in the same page", async () => {
    const page0 = ["X", "X", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      const offset = Number(url.searchParams.get("offset") ?? "0");
      if (offset === 0) return okResponse(page0);
      return okResponse([]);
    });

    const tracks = await fetchRecentlyPlayed("dev", "user");

    expect(tracks[0].id).toBe("X");
    expect(tracks[1].id).toBe("X");
    expect(tracks.filter((t) => t.id === "X")).toHaveLength(2);
  });
});
