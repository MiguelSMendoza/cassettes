import { it, expect } from "vitest";
import { parseYouTube } from "../src/domain/youtube";
it("normaliza YouTube, Music y URLs cortas y rechaza hosts manipulados", () => {
  for (const url of [
    "https://youtu.be/BaW_jenozKc",
    "https://music.youtube.com/watch?v=BaW_jenozKc",
    "https://www.youtube.com/watch?v=BaW_jenozKc",
  ])
    expect(parseYouTube(url).videoId).toBe("BaW_jenozKc");
  for (const url of [
    "file:///etc/passwd",
    "https://youtube.com.evil.com/watch?v=BaW_jenozKc",
    "https://u:p@youtube.com/watch?v=BaW_jenozKc",
  ])
    expect(() => parseYouTube(url)).toThrow();
});
it("requiere elegir alcance si el enlace contiene lista y vídeo", () =>
  expect(
    parseYouTube("https://youtube.com/watch?v=BaW_jenozKc&list=PL123456789")
      .playlistId,
  ).toBe("PL123456789"));
