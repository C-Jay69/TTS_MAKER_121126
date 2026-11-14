import { NextResponse } from "next/server";

import { handleRouteError, describeZodError, jsonError, readJsonObject } from "@/lib/server/api";
import { createProject, listProjects } from "@/lib/server/projects";
import { projectDraftSchema } from "@/lib/studio/projects";

// Persistence must never be prerendered or cached.
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json({ projects: await listProjects() });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = await readJsonObject(request);
    if (!body) return jsonError("Expected a JSON object body.", 400);

    const parsed = projectDraftSchema.safeParse(body);
    if (!parsed.success) return jsonError(describeZodError(parsed.error), 400);

    const project = await createProject(parsed.data);
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
