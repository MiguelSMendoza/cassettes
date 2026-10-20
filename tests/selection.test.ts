import { it, expect } from "vitest";
import { makeOccurrences } from "../src/domain/selection";
import { buildPlan } from "../src/domain/planner";
import { defaultConfig, type Track, type Playlist } from "../src/domain/types";
it("una entrada inaccesible no desaparece de un plan de lista", () => {
  const track: Track = {
    id: "track",
    title: "Disponible",
    artist: "",
    album: "",
    genres: [],
    disc: null,
    trackNumber: null,
    hidden: false,
    sources: [
      {
        id: "source",
        trackId: "track",
        kind: "local",
        durationMs: 1000,
        revision: "1000",
        videoId: "BaW_jenozKc",
        locations: [],
        available: true,
      },
    ],
  };
  const playlist: Playlist = {
    id: "list",
    name: "Lista",
    private: false,
    partial: false,
    items: [
      { id: "one", trackId: "track", title: "Disponible" },
      { id: "missing", trackId: null, title: "No disponible" },
      { id: "repeat", trackId: "track", title: "Disponible" },
    ],
  };
  const items = makeOccurrences([], {
    playlist,
    allTracks: [track],
    keepRepeats: true,
    sourceChoices: {},
  });
  const plan = buildPlan(items, defaultConfig);
  expect(plan.sides.flatMap((s) => s.tracks.map((t) => t.id)).sort()).toEqual([
    "one",
    "repeat",
  ]);
  expect(plan.excluded).toContainEqual({
    id: "missing",
    title: "No disponible",
    reason: "Duración desconocida o inválida",
  });
  expect(
    makeOccurrences([], {
      playlist,
      allTracks: [track],
      keepRepeats: false,
      sourceChoices: {},
    }),
  ).toHaveLength(2);
});

it("las referencias remotas antiguas quedan excluidas hasta descargar MP3", () => {
  const items = makeOccurrences(
    [
      {
        id: "t",
        title: "Referencia",
        artist: "",
        album: "",
        genres: [],
        disc: null,
        trackNumber: null,
        hidden: false,
        sources: [
          {
            id: "s",
            trackId: "t",
            kind: "youtube",
            durationMs: 1000,
            revision: "r",
            locations: [],
            available: true,
          },
        ],
      },
    ],
    { allTracks: [], keepRepeats: true, sourceChoices: { t: "s" } },
  );
  expect(items[0]?.kind).toBe("local");
  expect(items[0]?.durationMs).toBe(0);
  expect(buildPlan(items, defaultConfig).excluded).toHaveLength(1);
});
