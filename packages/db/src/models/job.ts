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
    status: {
      type: String,
      enum: ["pending", "running", "completed", "failed"],
      default: "pending",
    },
    createdAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
  },
  { versionKey: false, _id: false },
);

export const JobModel = model("Job", jobSchema);
