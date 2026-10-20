export function parseYouTube(input: string): {
  videoId?: string;
  playlistId?: string;
  url: string;
} {
  const u = new URL(input.trim());
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    ![
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "youtu.be",
    ].includes(u.hostname)
  )
    throw new Error("Usa un enlace HTTPS de YouTube o YouTube Music.");
  const videoId =
    u.hostname === "youtu.be"
      ? u.pathname.slice(1).split("/")[0]
      : (u.searchParams.get("v") ?? undefined);
  const playlistId = u.searchParams.get("list") ?? undefined;
  if (videoId && !/^[\w-]{11}$/.test(videoId))
    throw new Error("El identificador de vídeo no es válido.");
  if (playlistId && !/^[\w-]{8,160}$/.test(playlistId))
    throw new Error("El identificador de lista no es válido.");
  if (!videoId && !playlistId)
    throw new Error("El enlace debe apuntar a un vídeo o una lista.");
  return {
    videoId,
    playlistId,
    url: videoId
      ? `https://www.youtube.com/watch?v=${videoId}`
      : `https://www.youtube.com/playlist?list=${playlistId}`,
  };
}
