import { analyzeRepository } from "../../lib/github";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { repository?: string; token?: string; limit?: number };
    const result = await analyzeRepository(body.repository ?? "", body.token, body.limit ?? Infinity);
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Analysis failed" }, { status: 400 });
  }
}
