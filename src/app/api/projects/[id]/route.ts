import { NextResponse } from "next/server";

import { describeZodError, handleRouteError, jsonError, readJsonObject } from "@/lib/server/api";
import { deleteProject, getProject, updateProject } from "@/lib/server/projects";
import { projectDraftSchema } from "@/lib/studio/projects";

export const dynamic = "force-dynamic";

// Next.js 16: `params` is a Promise and must be awaited.
type ProjectRouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, ctx: ProjectRouteContext): Promise<NextResponse> {
  try {
    const { id } = await ctx.params;
    return NextResponse.json({ project: await getProject(id) });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(request: Request, ctx: ProjectRouteContext): Promise<NextResponse> {
  try {
    const { id } = await ctx.params;
    const body = await readJsonObject(request);
    if (!body) return jsonError("Expected a JSON object body.", 400);

    const parsed = projectDraftSchema.safeParse(body);
    if (!parsed.success) return jsonError(describeZodError(parsed.error), 400);

    return NextResponse.json({ project: await updateProject(id, parsed.data) });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(_request: Request, ctx: ProjectRouteContext): Promise<NextResponse> {
  try {
    const { id } = await ctx.params;
    await deleteProject(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
