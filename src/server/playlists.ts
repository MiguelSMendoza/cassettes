import type { Playlist } from "../domain/types";
import { Catalog, uid } from "./db";
import { UserError } from "./files";

/** Listas del catálogo local. Nunca escribe en YouTube ni modifica el audio. */
export class Playlists {
  constructor(private catalog: Catalog) {}
  private get(id: string) {
    const p = this.catalog.playlists().find((p) => p.id === id);
    if (!p) throw new UserError("La playlist ya no existe.");
    return p;
  }
  private entries(trackIds: string[]) {
    const tracks = new Map(this.catalog.tracks(true).map((t) => [t.id, t]));
    return [...new Set(trackIds)].map((id) => {
      const track = tracks.get(id);
      if (!track)
        throw new UserError(
          "Una canción ya no existe en la biblioteca. Actualiza la página.",
        );
      return { id: uid(), trackId: id, title: track.title };
    });
  }
  create(name: string, trackIds: string[]): Playlist {
    name = name.trim();
    if (!name || name.length > 200)
      throw new UserError("Escribe un nombre de entre 1 y 200 caracteres.");
    const p: Playlist = {
      id: uid(),
      name,
      origin: { kind: "local" },
      private: false,
      partial: false,
      items: this.entries(trackIds),
    };
    this.catalog.savePlaylist(p, null);
    return p;
  }
  add(id: string, trackIds: string[]): Playlist {
    const p = this.get(id);
    const seen = new Set(p.items.map((i) => i.trackId));
    p.items.push(...this.entries(trackIds).filter((i) => !seen.has(i.trackId)));
    if (p.items.length > 20000)
      throw new UserError("Una playlist admite hasta 20 000 canciones.");
    this.catalog.updatePlaylist(p);
    return p;
  }
  rename(id: string, name: string): Playlist {
    const p = this.get(id);
    name = name.trim();
    if (!name || name.length > 200)
      throw new UserError("Escribe un nombre de entre 1 y 200 caracteres.");
    p.name = name;
    this.catalog.updatePlaylist(p);
    return p;
  }
  delete(id: string) {
    this.get(id);
    this.catalog.deletePlaylist(id);
  }
  remove(id: string, itemId: string): Playlist {
    const p = this.get(id);
    p.items = p.items.filter((i) => i.id !== itemId);
    this.catalog.updatePlaylist(p);
    return p;
  }
}
