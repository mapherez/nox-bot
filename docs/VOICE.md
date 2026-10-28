# NoX Voice on Discord

NoX Voice connects [nox-voice-mlx](https://github.com/mapherez/nox-voice-mlx) to one normal Discord voice channel for a shared conversation. Text commands, Quick Commands, other plugins and the dashboard continue working. The bot converts and relays audio to that service. This integration uses its controller directly and does not depend on its webapp, Google login or a public tunnel. For service installation and deployment requirements, follow the nox-voice-mlx repository.

## One-time deployment setup

1. Use a bot image built from this version. Its normal Docker build includes Discord Voice, DAVE encryption and native Opus for Linux AMD64 and ARM64. No host Python, FFmpeg or npm installation is required for Docker deployment.
2. Start the controller following the instructions in the [nox-voice-mlx repository](https://github.com/mapherez/nox-voice-mlx). Use its **HTTPS controller address**, including its actual configured port, reachable from the Docker host. The certificate must cover that hostname/IP. `localhost` in a container refers to that container; use the address where the external service is deployed. This plugin does not change the service deployment or install an autostart service.
3. Reuse the existing client bundle's `ca.crt`, `client.crt` and `client.key`. Set `NOX_VOICE_SECRETS_DIR` in the bot's `.env` to their host directory; it may be the directory already used by the voice webapp. Set `NOX_VOICE_CONTROLLER_URL` to the controller address. Keep the three `NOX_VOICE_*_FILE` values at their documented container paths from `.env.example`.
4. Copy `docker-compose.voice.example.yml` to `docker-compose.override.yml` once, next to `docker-compose.yml`. Compose loads this name automatically. The override mounts **only the three individual files**, read-only, and does not mount the rest of the directory. Docker must be able to traverse the host directory and UID/GID **10001** inside the container must be able to read the mounted files. Use the host's existing group/ACL mechanism to grant narrowly scoped read access; do not make the private key world-readable. The bot does not change host ownership/permissions, copy keys, or start a privileged bootstrap.
5. Run the normal **`docker compose up -d`**. There are no recurring preparation commands. A missing bind source fails clearly rather than creating a directory in its place. The base Compose deployment still runs without the optional override or voice configuration.

Never mount the CA **private key** or server private key. The client private key is required at runtime for mTLS and is readable by the bot process; it is not baked into the image. The existing client credential gives the bot the same controller access as the voice webapp. Protect the Docker host and rotate this client bundle through nox-voice-mlx if it is compromised or expires. HTTPS verifies the controller CA and hostname; redirects are not followed and certificate verification is never disabled.

Discord needs View Channel, Connect and Speak permissions in the selected channel. The bot requests the standard Guild Voice States intent and joins with self-deafen disabled. Stage channels are not supported. Voice needs UDP connectivity through the container host/NAT in addition to the existing Discord HTTPS/WebSocket access. No fixed inbound voice port is published by this Compose override.

## Use the dashboard

1. Open **Plugins → NoX Voice → Configure** in your server.
2. Choose the voice channel and save. Everyone in that channel can talk to the bot and hear its replies; there is no user-ID list.
3. Check the controller connection. Select a voice, persona/prompt and quantization using the voice settings. These are read from and written to the nox-voice-mlx controller, so they are shared with the dedicated webapp rather than copied into the bot database.
4. If needed, press **Start engine** and wait for **Ready**. This starts the external engine but does not enable the Discord plugin.
5. Enable the plugin on its card. The voice service must be ready and free. A webapp conversation already using it is not interrupted.

The bot mixes human participants into one audio input and conversation context and keeps an 80 ms clock, supplying digital silence when Discord sends no voice packets. It keeps listening during the bot's replies for interruptions. Overlapping voices are mixed without guaranteed speaker identification. Other bots are excluded, including the bot's own output. No audio recordings or transcripts are stored by the bridge.

The engine supports one conversation at a time: either Discord or the webapp. An empty Discord channel **keeps its session/context**, continues processing silence and keeps the voice service occupied. Disable the plugin to free that conversation; disabling leaves the voice service running.

**Apply and restart conversation** updates voice settings and starts fresh context while the bot stays in the channel. Changing channel also starts fresh context. Stop/Restart engine disconnects voice, and enabling it again is a separate manual action. The drawer shows controller/engine/Discord status, memory, uptime and connection diagnostics. Unsaved settings are kept while status refreshes; use **Reload current settings** to discard the draft and fetch the current shared values.

After a bot/container restart, engine shutdown, voice disconnect or a connection failure to nox-voice-mlx, the bot **does not rejoin automatically**. Configuration remains saved; explicitly enable NoX Voice again when the voice service is ready. This manual policy applies only to voice; existing plugin recovery remains unchanged.

## Validation

`npm run typecheck` and `npm test` cover audio frame conversion, mixing/silence/queue limits, manual lifecycle and dashboard authorization. Native Opus and the installed DAVE implementation are checked without contacting Discord. The actual Discord receive/playback path needs a final live test: enable the plugin yourself in your chosen channel, verify two human speakers and interruptions, and use a normal text command during voice. Then disable/re-enable and restart the bot to confirm the manual policy. Do not treat offline tests as proof of a live Discord/DAVE session.

Discord Voice supports receiving audio, but Discord does not document this receive protocol; library updates can affect compatibility. The pinned dependency is `@discordjs/voice` 0.19.2 with DAVE support. See the [official library documentation](https://discord.js.org/docs/packages/voice/0.19.2) and [Discord voice protocol](https://docs.discord.com/developers/topics/voice-connections).
