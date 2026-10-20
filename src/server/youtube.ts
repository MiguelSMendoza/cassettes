import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { Catalog, uid, type SourceRow } from "./db";
import { runYt } from "./tools";
import { parseYouTube } from "../domain/youtube";
import { UserError } from "./files";
import type { Playlist } from "../domain/types";
const videoSchema = z.object({
  id: z.string(),
  title: z.string().default("Sin título"),
  duration: z.number().nullable().optional(),
  is_live: z.boolean().optional(),
  channel: z.string().nullish(),
  entries: z.array(z.unknown()).optional(),
});
const flatSchema = z.object({
  id: z.string(),
  title: z.string().nullish(),
  duration: z.number().nullish(),
});
const apiVideo = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      snippet: z.object({ title: z.string() }),
      contentDetails: z.object({ duration: z.string() }),
      status: z.object({ embeddable: z.boolean() }),
    }),
  ),
});
function durationISO(s: string) {
  const m = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(
    s,
  );
  return m
    ? Math.ceil(
        (Number(m[1] ?? 0) * 86400 +
          Number(m[2] ?? 0) * 3600 +
          Number(m[3] ?? 0) * 60 +
          Number(m[4] ?? 0)) *
          1000,
      )
    : null;
}
export class YouTube {
  private drafts = new Map<
    string,
    {
      playlist: Playlist;
      videos: Map<string, { title: string; durationMs: number | null }>;
    }
  >();
  private stageGeneration = 0;
  private tokens: { access: string; refresh?: string; expires: number } | null =
    null;
  private pending: { state: string; verifier: string; created: number } | null =
    null;
  constructor(
    readonly catalog: Catalog,
    readonly port: number,
  ) {}
  get configured() {
    return !!process.env.GOOGLE_CLIENT_ID;
  }
  get connected() {
    return this.tokens !== null;
  }
  private redirect() {
    return `http://127.0.0.1:${this.port}/api/google/callback`;
  }
  authUrl() {
    if (!this.configured)
      throw new UserError(
        "Configura GOOGLE_CLIENT_ID en .env para conectar tu cuenta.",
      );
    const state = randomBytes(32).toString("hex"),
      verifier = randomBytes(48).toString("base64url");
    this.pending = { state, verifier, created: Date.now() };
    const p = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      redirect_uri: this.redirect(),
      response_type: "code",
      scope: "https://www.googleapis.com/auth/youtube.readonly",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
  }
  async callback(code: string, state: string) {
    const pending = this.pending;
    this.pending = null;
    if (
      !pending ||
      state !== pending.state ||
      Date.now() - pending.created > 600000
    )
      throw new UserError("La conexión ha caducado o no es válida.");
    const body = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      redirect_uri: this.redirect(),
      grant_type: "authorization_code",
      code,
      code_verifier: pending.verifier,
    });
    if (process.env.GOOGLE_CLIENT_SECRET)
      body.set("client_secret", process.env.GOOGLE_CLIENT_SECRET);
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      body,
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok)
      throw new UserError(
        "Google no pudo completar la conexión. Revisa el cliente OAuth y la URL de retorno.",
      );
    const t = z
      .object({
        access_token: z.string(),
        refresh_token: z.string().optional(),
        expires_in: z.number(),
      })
      .parse(await r.json());
    this.tokens = {
      access: t.access_token,
      refresh: t.refresh_token,
      expires: Date.now() + t.expires_in * 1000,
    };
  }
  async disconnect() {
    const token = this.tokens?.refresh ?? this.tokens?.access;
    this.tokens = null;
    this.pending = null;
    this.drafts.clear();
    this.stageGeneration++;
    this.catalog.expire(true);
    if (token)
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        body: new URLSearchParams({ token }),
        signal: AbortSignal.timeout(10000),
      }).catch(() => {});
  }
  private async token() {
    if (!this.tokens)
      throw new UserError("Conecta Google para acceder a listas privadas.");
    if (this.tokens.expires < Date.now() + 30000) {
      if (!this.tokens.refresh) {
        this.tokens = null;
        throw new UserError(
          "La sesión de Google ha caducado. Vuelve a conectar.",
        );
      }
      const body = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        grant_type: "refresh_token",
        refresh_token: this.tokens.refresh,
      });
      if (process.env.GOOGLE_CLIENT_SECRET)
        body.set("client_secret", process.env.GOOGLE_CLIENT_SECRET);
      const r = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        body,
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) {
        await this.disconnect();
        throw new UserError("Google ha revocado la sesión. Vuelve a conectar.");
      }
      const data = z
        .object({ access_token: z.string(), expires_in: z.number() })
        .parse(await r.json());
      this.tokens.access = data.access_token;
      this.tokens.expires = Date.now() + data.expires_in * 1000;
    }
    return this.tokens.access;
  }
  private async api(
    endpoint: string,
    params: Record<string, string>,
    authenticated = false,
  ) {
    const u = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const headers: Record<string, string> = {};
    if (authenticated) headers.Authorization = `Bearer ${await this.token()}`;
    else if (process.env.YOUTUBE_API_KEY)
      u.searchParams.set("key", process.env.YOUTUBE_API_KEY);
    else
      throw new UserError(
        "Configura YOUTUBE_API_KEY o conecta Google para usar la API de listas.",
      );
    const r = await fetch(u, { headers, signal: AbortSignal.timeout(20000) });
    if (!r.ok)
      throw new UserError(
        `YouTube devolvió ${r.status}. Comprueba permisos, cuota y disponibilidad.`,
      );
    return r.json() as Promise<unknown>;
  }
  upsert(
    videoId: string,
    title: string,
    durationMs: number | null,
    privateAccount: string | null = null,
    knownTrack?: string,
  ) {
    let existing = this.catalog.db
      .prepare("SELECT * FROM sources WHERE kind='youtube' AND key=?")
      .get(videoId) as SourceRow | undefined;
    if (existing) {
      if (
        privateAccount &&
        !existing.private_account &&
        existing.fetched_at > Date.now() - 30 * 86400000
      )
        return existing.track_id;
      this.catalog.db
        .prepare(
          "UPDATE sources SET duration_ms=?,fetched_at=?,revision=?,private_account=? WHERE id=?",
        )
        .run(
          durationMs,
          Date.now(),
          String(durationMs ?? 0),
          privateAccount,
          existing.id,
        );
      this.catalog.db
        .prepare("UPDATE tracks SET title=? WHERE id=?")
        .run(title, existing.track_id);
      return existing.track_id;
    }
    const trackId = knownTrack ?? uid(),
      sourceId = uid();
    this.catalog.db.transaction(() => {
      this.catalog.db
        .prepare("INSERT OR IGNORE INTO tracks(id,title) VALUES(?,?)")
        .run(trackId, title);
      this.catalog.db
        .prepare("INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?)")
        .run(
          sourceId,
          trackId,
          "youtube",
          videoId,
          durationMs,
          String(durationMs ?? 0),
          "{}",
          Date.now(),
          privateAccount,
        );
    })();
    return trackId;
  }
  async publicInfo(url: string) {
    const p = parseYouTube(url);
    if (!p.videoId) throw new UserError("Falta vídeo.");
    const v = videoSchema.parse(
      JSON.parse(
        await runYt([
          "--dump-single-json",
          "--skip-download",
          "--no-playlist",
          "--",
          p.url,
        ]),
      ),
    );
    if (v.is_live) throw new UserError("No se admiten directos.");
    return {
      id: p.videoId,
      title: v.title,
      durationMs: v.duration ? Math.ceil(v.duration * 1000) : null,
    };
  }
  async video(url: string) {
    const p = parseYouTube(url);
    if (!p.videoId) throw new UserError("Elige importar la lista completa.");
    if (process.env.YOUTUBE_API_KEY) {
      const v = apiVideo.parse(
        await this.api(
          "videos",
          { id: p.videoId, part: "snippet,contentDetails,status" },
          false,
        ),
      ).items[0];
      if (!v) throw new UserError("El vídeo no está disponible.");
      return this.upsert(
        v.id,
        v.snippet.title,
        v.status.embeddable ? durationISO(v.contentDetails.duration) : null,
        null,
      );
    }
    const v = videoSchema.parse(
      JSON.parse(
        await runYt([
          "--dump-single-json",
          "--skip-download",
          "--no-playlist",
          "--",
          p.url,
        ]),
      ),
    );
    if (v.is_live) throw new UserError("Los directos no se pueden planificar.");
    return this.upsert(
      p.videoId,
      v.title,
      v.duration ? Math.ceil(v.duration * 1000) : null,
    );
  }
  async previewPlaylist(
    url: string,
    authenticated: boolean,
  ): Promise<Playlist> {
    const p = parseYouTube(url);
    if (!p.playlistId) throw new UserError("El enlace no incluye una lista.");
    const generation = this.stageGeneration;
    const videos = new Map<
      string,
      { title: string; durationMs: number | null }
    >();
    const stage = (id: string, title: string, durationMs: number | null) => {
      videos.set(id, { title, durationMs });
      return id;
    };
    const items: Playlist["items"] = [];
    let name = "Lista de YouTube";
    let partial = false;
    if (authenticated || process.env.YOUTUBE_API_KEY) {
      const title = z
        .object({
          items: z.array(
            z.object({ snippet: z.object({ title: z.string() }) }),
          ),
        })
        .parse(
          await this.api(
            "playlists",
            { id: p.playlistId, part: "snippet" },
            authenticated,
          ),
        );
      name = title.items[0]?.snippet.title ?? name;
      let page = "";
      do {
        const raw = await this.api(
          "playlistItems",
          {
            playlistId: p.playlistId,
            part: "snippet,contentDetails",
            maxResults: "50",
            ...(page ? { pageToken: page } : {}),
          },
          authenticated,
        );
        const result = z
          .object({
            nextPageToken: z.string().optional(),
            items: z.array(
              z.object({
                id: z.string(),
                snippet: z.object({
                  title: z.string(),
                  resourceId: z.object({ videoId: z.string().optional() }),
                }),
              }),
            ),
          })
          .parse(raw);
        for (const e of result.items) {
          const videoId = e.snippet.resourceId.videoId;
          let trackId: string | null = null;
          if (videoId) {
            const v = apiVideo.parse(
              await this.api(
                "videos",
                { id: videoId, part: "snippet,contentDetails,status" },
                authenticated,
              ),
            ).items[0];
            if (v)
              trackId = stage(
                v.id,
                v.snippet.title,
                v.status.embeddable
                  ? durationISO(v.contentDetails.duration)
                  : null,
              );
          }
          items.push({ id: e.id, trackId, title: e.snippet.title });
        }
        page = result.nextPageToken ?? "";
        if (items.length >= 1000 && page) {
          partial = true;
          break;
        }
      } while (page);
    } else {
      const raw = videoSchema
        .extend({ entries: z.array(flatSchema) })
        .parse(
          JSON.parse(
            await runYt(
              [
                "--flat-playlist",
                "--dump-single-json",
                "--playlist-end",
                "1001",
                "--",
                `https://www.youtube.com/playlist?list=${p.playlistId}`,
              ],
              { timeoutMs: 180000 },
            ),
          ),
        );
      name = raw.title;
      partial = raw.entries.length > 1000;
      for (const [i, e] of raw.entries.slice(0, 1000).entries()) {
        const valid = /^[\w-]{11}$/.test(e.id);
        items.push({
          id: `${p.playlistId}:${i}`,
          trackId: valid
            ? stage(
                e.id,
                e.title ?? e.id,
                e.duration ? Math.ceil(e.duration * 1000) : null,
              )
            : null,
          title: e.title ?? "No disponible",
        });
      }
    }
    if (generation !== this.stageGeneration)
      throw new UserError(
        "La cuenta se desconectó. Vuelve a importar la lista.",
      );
    const playlist: Playlist = {
      id: uid(),
      origin: {
        kind: "youtube",
        playlistId: p.playlistId,
        url: `https://www.youtube.com/playlist?list=${p.playlistId}`,
      },
      name,
      private: authenticated,
      items,
      partial,
    };
    this.drafts.set(playlist.id, { playlist, videos });
    return playlist;
  }
  async downloadPlaylist(
    id: string,
    downloads: import("./downloads").Downloads,
  ): Promise<Playlist> {
    const draft = this.drafts.get(id);
    if (!draft) throw new UserError("Vuelve a previsualizar la lista.");
    if (draft.playlist.private && !this.connected)
      throw new UserError("La cuenta ya no está conectada.");
    const playlist: Playlist = {
      ...draft.playlist,
      items: draft.playlist.items.map((item) => ({
        ...item,
        videoId: item.trackId ?? undefined,
        trackId: null,
      })),
    };
    const saved = await downloads.playlist(playlist);
    this.drafts.delete(id);
    return saved;
  }
}
