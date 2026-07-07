import { loadEnv } from "@crawler/config";
import { createRedis, createCrawlQueue } from "@crawler/queue";
import { connectMongo, disconnectMongo } from "@crawler/db";
import { createApp } from "./app.js";

const env = loadEnv();
const redis = createRedis();
const queue = createCrawlQueue(redis);
await connectMongo();

const app = createApp({ redis, queue });
const server = app.listen(env.API_PORT, () => {
  console.log(`api listening on :${env.API_PORT}`);
});

async function shutdown(): Promise<void> {
  server.close();
  await queue.close();
  await redis.quit();
  await disconnectMongo();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
