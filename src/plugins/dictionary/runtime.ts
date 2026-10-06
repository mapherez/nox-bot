import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import * as cheerio from "cheerio";
import type { PluginContext, PluginRuntime, RichContent } from "../sdk.js";
import { readBounded } from "../http.js";
interface Dictionary {
  spell(word: string): Promise<boolean>;
  suggest(word: string): Promise<string[] | null>;
}
interface NativeDictionary {
  Nodehun: new (affix: Buffer, dictionary: Buffer) => Dictionary;
}
let dictionary: Dictionary | undefined;
async function correct(word: string): Promise<string> {
  try {
    if (!dictionary) {
      const module = createRequire(import.meta.url)(
        "nodehun",
      ) as NativeDictionary;
      const [affix, words] = await Promise.all([
        readFile(
          new URL(
            "../../assets/dictionaries/portuguese/pt_PT.aff",
            import.meta.url,
          ),
        ),
        readFile(
          new URL(
            "../../assets/dictionaries/portuguese/pt_PT.dic",
            import.meta.url,
          ),
        ),
      ]);
      dictionary = new module.Nodehun(affix, words);
    }
    if (await dictionary.spell(word)) return word;
    const suggestions = await dictionary.suggest(word);
    return (
      suggestions?.find(
        (s) => /[áéíóúâêôãõç]/.test(s) && Math.abs(s.length - word.length) <= 2,
      ) ??
      suggestions?.[0] ??
      word
    );
  } catch {
    return word;
  }
}
async function definition(context: PluginContext): Promise<RichContent> {
  const original = String(context.options.word ?? "")
    .trim()
    .toLowerCase();
  if (!original || original.length > 100)
    return { content: "Provide a Portuguese word: /definition <word>." };
  const word = await correct(original),
    url = `https://dicionario.priberam.org/${encodeURIComponent(word)}`;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      redirect: "error",
      headers: { "User-Agent": "NoX Bot Dictionary" },
    });
    if (response.status === 404)
      return { content: `“${word}” was not found in the Priberam dictionary.` };
    if (!response.ok) throw new Error("Dictionary service unavailable.");
    const $ = cheerio.load(
        new TextDecoder().decode(await readBounded(response, 1024 * 1024)),
      ),
      image = $("img.imagemdef").first().attr("src");
    const description = `${word !== original ? `Corrected “${original}” to “${word}”.\n\n` : ""}[View definition on Priberam](${url})`;
    const embed = {
      color: 0x8b5cf6,
      title: `Definition: ${word}`,
      description,
      footer: { text: "Priberam · NoX Bot" },
    };
    if (image) {
      try {
        const imageUrl = new URL(image, url);
        if (
          imageUrl.protocol !== "https:" ||
          imageUrl.hostname !== "dicionario.priberam.org"
        )
          throw new Error("Unexpected definition image source.");
        const result = await fetch(imageUrl, {
          signal: AbortSignal.timeout(10000),
          redirect: "error",
        });
        if (!result.ok) throw new Error("Definition image unavailable.");
        const bytes = await readBounded(result, 8 * 1024 * 1024);
        return {
          embeds: [{ ...embed, image: { url: "attachment://definition.png" } }],
          attachments: [{ name: "definition.png", data: bytes }],
        };
      } catch {
        return { embeds: [embed] };
      }
    }
    // Preserve a useful text/link fallback when Priberam changes its image layout.
    const text = $(".def").first().text().trim();
    return {
      embeds: [
        {
          ...embed,
          description: `${text ? text.slice(0, 2500) + "\n\n" : ""}${description}`,
        },
      ],
    };
  } catch {
    return {
      content:
        "Could not fetch the definition right now. Please try again later.",
    };
  }
}
const runtime: PluginRuntime = {
  handlers: { definition },
  dispose: async () => {
    dictionary = undefined;
  },
};
export default runtime;
