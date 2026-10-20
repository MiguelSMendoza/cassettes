import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Catalog } from "../src/server/db";
import { buildPlan } from "../src/domain/planner";
import { defaultConfig, type Occurrence } from "../src/domain/types";
const directory = await mkdtemp(path.join(os.tmpdir(), "cassettes-benchmark-"));
const c = new Catalog(directory);
const root = c.setRoot(directory);
const insertTrack = c.db.prepare("INSERT INTO tracks(id,title) VALUES(?,?)");
const insertSource = c.db.prepare(
  "INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?)",
);
const insertLocation = c.db.prepare(
  "INSERT INTO locations VALUES(?,?,?,?,?,?,1,0,NULL)",
);
c.db.transaction(() => {
  for (let i = 0; i < 10000; i++) {
    const id = String(i),
      hash = createHash("sha256").update(id).digest("hex");
    insertTrack.run(id, `Canción ${i}`);
    insertSource.run(
      id,
      id,
      "local",
      hash,
      180000,
      hash,
      "{}",
      Date.now(),
      null,
    );
    insertLocation.run(id, id, root.id, `${i}.mp3`, 100, 0);
  }
})();
const start = performance.now();
const tracks = c.tracks();
const listMs = performance.now() - start;
const input: Occurrence[] = tracks.slice(0, 100).map((t, i) => ({
  id: t.id,
  trackId: t.id,
  sourceId: t.sources[0]!.id,
  revision: t.sources[0]!.revision,
  durationMs: 120000 + i * 1973,
  title: t.title,
  artist: "",
  kind: "local",
}));
const pstart = performance.now();
const plan = buildPlan(input, defaultConfig, 1500);
console.log(
  JSON.stringify({
    catalogEntries: tracks.length,
    catalogQueryMs: Math.round(listMs),
    planningTracks: 100,
    planningMs: Math.round(performance.now() - pstart),
    faces: plan.sides.length,
    assigned: plan.sides.flatMap((s) => s.tracks).length,
    optimality: plan.optimality,
  }),
);
c.close();
