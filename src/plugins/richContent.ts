import { isRecord } from "../core/state.js";
import type { PluginDefinition, RichContent } from "./sdk.js";
export function validateRichContent(
  value: unknown,
  definition: PluginDefinition,
): asserts value is RichContent {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        !["content", "embeds", "components", "attachments"].includes(key),
    )
  )
    throw new Error("Invalid plugin response contract.");
  if (
    value.content !== undefined &&
    (typeof value.content !== "string" || value.content.length > 2000)
  )
    throw new Error("Invalid plugin text.");
  if (
    value.embeds !== undefined &&
    (!Array.isArray(value.embeds) || value.embeds.length > 10)
  )
    throw new Error("Invalid plugin embeds.");
  let textSize = 0;
  for (const embed of (value.embeds ?? []) as unknown[]) {
    if (
      !isRecord(embed) ||
      Object.keys(embed).some(
        (key) =>
          ![
            "title",
            "description",
            "url",
            "color",
            "timestamp",
            "footer",
            "image",
            "thumbnail",
            "author",
            "fields",
          ].includes(key),
      )
    )
      throw new Error("Invalid embed contract.");
    const text = (input: unknown, limit: number) => {
      if (
        input !== undefined &&
        (typeof input !== "string" || input.length > limit)
      )
        throw new Error("Invalid embed text.");
      textSize += typeof input === "string" ? input.length : 0;
    };
    text(embed.title, 256);
    text(embed.description, 4096);
    if (
      embed.fields !== undefined &&
      (!Array.isArray(embed.fields) || embed.fields.length > 25)
    )
      throw new Error("Invalid embed fields.");
    for (const field of (embed.fields ?? []) as unknown[]) {
      if (!isRecord(field)) throw new Error("Invalid embed field.");
      text(field.name, 256);
      text(field.value, 1024);
    }
    if (embed.footer !== undefined) {
      if (!isRecord(embed.footer)) throw new Error("Invalid embed footer.");
      text(embed.footer.text, 2048);
    }
    if (embed.author !== undefined) {
      if (!isRecord(embed.author)) throw new Error("Invalid embed author.");
      text(embed.author.name, 256);
    }
  }
  if (textSize > 6000) throw new Error("Plugin embeds exceed Discord limits.");
  if (value.components !== undefined) {
    if (
      !definition.capabilities.includes("interactive") ||
      !Array.isArray(value.components) ||
      value.components.length > 20
    )
      throw new Error("Plugin lacks interactive capability.");
    let rows = 0,
      buttons = 0;
    for (const item of value.components) {
      if (
        !isRecord(item) ||
        typeof item.action !== "string" ||
        !definition.componentHandlers?.includes(item.action)
      )
        throw new Error("Undeclared component handler.");
      if (item.kind === "button") {
        if (
          typeof item.label !== "string" ||
          !item.label ||
          item.label.length > 80 ||
          (item.style !== undefined &&
            !["primary", "secondary", "danger"].includes(String(item.style))) ||
          (item.disabled !== undefined && typeof item.disabled !== "boolean")
        )
          throw new Error("Invalid plugin button.");
        if (buttons++ % 5 === 0) rows++;
      } else if (item.kind === "select") {
        buttons = 0;
        rows++;
        if (
          !Array.isArray(item.options) ||
          !item.options.length ||
          item.options.length > 25 ||
          item.options.some(
            (option) =>
              !isRecord(option) ||
              typeof option.label !== "string" ||
              !option.label ||
              option.label.length > 100 ||
              typeof option.value !== "string" ||
              !option.value ||
              option.value.length > 100,
          )
        )
          throw new Error("Invalid plugin select.");
      } else throw new Error("Invalid plugin component.");
    }
    if (rows > 5) throw new Error("Plugin components exceed Discord limits.");
  }
  if (value.attachments !== undefined) {
    if (
      !definition.capabilities.includes("attachments") ||
      !Array.isArray(value.attachments) ||
      value.attachments.length > 10
    )
      throw new Error("Plugin lacks attachments capability.");
    let size = 0;
    for (const file of value.attachments) {
      if (
        !isRecord(file) ||
        typeof file.name !== "string" ||
        !/^[a-zA-Z0-9_.-]{1,100}$/.test(file.name) ||
        !(file.data instanceof Uint8Array) ||
        !file.data.length ||
        file.data.length > 8 * 1024 * 1024
      )
        throw new Error("Invalid plugin attachment.");
      size += file.data.length;
    }
    if (size > 25 * 1024 * 1024)
      throw new Error("Plugin attachments exceed message limits.");
  }
  if (
    !value.content &&
    !(value.embeds as unknown[] | undefined)?.length &&
    !(value.attachments as unknown[] | undefined)?.length
  )
    throw new Error("Empty plugin response.");
}
