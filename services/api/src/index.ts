import { loadEnv } from "@crawler/config";
import { createLogger } from "@crawler/logger";
import { createRedis, createCrawlQueue, createRenderQueue } from "@crawler/queue";
import { connectMongo, disconnectMongo } from "@crawler/db";
import { createApp } from "./app.js";

const log = createLogger("api");
const env = loadEnv();
const redis = createRedis();
const queue = createCrawlQueue(redis);
const renderQueue = createRenderQueue(redis);
await connectMongo();

const app = createApp({ redis, queue, renderQueue });
const server = app.listen(env.API_PORT, () => {
  log.info({ port: env.API_PORT }, "api listening");
});

async function shutdown(): Promise<void> {
  server.close();
  await queue.close();
  await renderQueue.close();
  await redis.quit();
  await disconnectMongo();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
