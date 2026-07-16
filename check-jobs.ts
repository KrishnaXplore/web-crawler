import { connectMongo } from './packages/db/src/index.ts';
import { JobModel } from './packages/db/src/index.ts';
import { loadEnv } from './packages/config/src/index.ts';

async function run() {
  loadEnv();
  await connectMongo();
  const jobs = await JobModel.find().sort({ createdAt: -1 }).limit(5).lean();
  console.log(jobs.map(j => ({ id: j.id, seedUrl: j.seedUrl, intent: j.config?.intent })));
  process.exit(0);
}
run().catch(console.error);
