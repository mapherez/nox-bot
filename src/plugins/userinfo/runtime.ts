import type { PluginRuntime } from "../sdk.js";
const runtime: PluginRuntime = {
  handlers: {
    userinfo: async (context) => {
      const user =
        typeof context.options.user === "string"
          ? context.users[context.options.user]
          : context.user;
      if (!user)
        return { content: "That user is not available in this server." };
      return {
        embeds: [
          {
            color: 0x8b5cf6,
            title: `${user.username}’s Information`,
            thumbnail: { url: user.avatarURL },
            fields: [
              { name: "Username", value: user.username, inline: true },
              { name: "User ID", value: user.id, inline: true },
              {
                name: "Account created",
                value: `<t:${Math.floor(user.createdTimestamp / 1000)}:F>`,
              },
              {
                name: "Joined server",
                value: user.joinedTimestamp
                  ? `<t:${Math.floor(user.joinedTimestamp / 1000)}:F>`
                  : "Unknown",
              },
              {
                name: "Roles",
                value: user.roles.join(", ").slice(0, 1024) || "No roles",
              },
            ],
            footer: { text: "NoX Bot" },
          },
        ],
      };
    },
  },
};
export default runtime;
