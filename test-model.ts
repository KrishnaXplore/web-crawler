import { GoogleGenAI } from "@google/genai";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env" });
const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
async function test() {
  try {
    const response = await client.models.generateContent({
      model: "gemini-3.1-flash-lite",
      contents: "Hello",
    });
    console.log(response.text);
  } catch(e) {
    console.error("FAILED:", e);
  }
}
test();
