import { RuleModel } from "./models/rule.js";

export interface ExtractionRule {
  readonly domain: string;
  readonly schemaType: string;
  readonly fields: Record<string, string>;
}

export async function getRulesForDomain(domain: string): Promise<ExtractionRule | null> {
  const doc = await RuleModel.findById(domain).lean();
  if (!doc) return null;
  
  // Convert Mongoose Map/Object to plain Record
  const fields = (doc.fields ? Object.fromEntries(Object.entries(doc.fields)) : {}) as Record<string, string>;
  
  return {
    domain: doc._id,
    schemaType: doc.schemaType,
    fields,
  };
}

export async function upsertRule(rule: ExtractionRule): Promise<void> {
  await RuleModel.updateOne(
    { _id: rule.domain },
    {
      $set: {
        schemaType: rule.schemaType,
        fields: rule.fields,
        updatedAt: new Date(),
      }
    },
    { upsert: true }
  );
}
