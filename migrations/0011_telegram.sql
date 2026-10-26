-- Pushes go through Telegram bots: ntfy.sh limits by IP and a Worker sends from IPs Cloudflare shares, and Bark is
-- iPhone only. Their channels go; routes keep the ids of the others (a missing one is skipped when sending)
DELETE FROM channels WHERE kind IN ('ntfy', 'bark');
