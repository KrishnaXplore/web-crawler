import mongoose from "mongoose";
const { Schema, model } = mongoose;

/**
 * The durable job record: its config and status. `_id` is the caller-supplied job
 * id (a UUID). Status flips to "completed" once completion detection lands (M4).
 */
const jobSchema = new Schema(
  {
    _id: { type: String, required: true }, // jobId (UUID)
    seedUrl: { type: String, required: true },
    maxDepth: { type: Number, required: true },
    maxPages: { type: Number, required: true },
    sameHostOnly: { type: Boolean, required: true },
    respectRobots: { type: Boolean, required: true },
    storeHtml: { type: Boolean, default: false },
    plugins: { type: [String], default: [] },
    // Optional terminal-state callback (M6 Step B).
    webhookUrl: { type: String, default: null },
    status: {
      type: String,
      // cancelling → cancelled is the two-phase cancel (M6): between the API call
      // and the queue draining, in-flight URLs are still finishing.
      enum: ["pending", "running", "cancelling", "completed", "cancelled", "failed"],
      default: "pending",
    },
    createdAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
  },
  { versionKey: false, _id: false },
);

export const JobModel = model("Job", jobSchema);
