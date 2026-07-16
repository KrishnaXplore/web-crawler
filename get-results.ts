import { connectMongo } from './packages/db/src/index.ts';
import { JobModel, PageModel } from './packages/db/src/index.ts';
import { loadEnv } from './packages/config/src/index.ts';

async function run() {
  loadEnv();
  await connectMongo();
  const job = await JobModel.findOne({ seedUrl: { $regex: 'amazon.in' } }).sort({ createdAt: -1 }).lean();
  if (!job) {
    console.log("Job not found");
    process.exit(1);
  }
  console.log("Job:", job._id.toString(), "Seed:", job.seedUrl);
  
  const seedPage = await PageModel.findOne({ jobId: job._id.toString(), depth: 0 }).lean();
  console.log("HTML stored:", !!seedPage?.htmlBytes, seedPage?.htmlBytes?.length);
  process.exit(0);
}
run().catch(console.error);
