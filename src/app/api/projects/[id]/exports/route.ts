import { NextResponse } from "next/server";

import { describeZodError, handleRouteError, jsonError, readJsonObject } from "@/lib/server/api";
import { recordAudioAsset } from "@/lib/server/projects";
import { audioAssetSchema } from "@/lib/studio/projects";

export const dynamic = "force-dynamic";

type ProjectRouteContext = { params: Promise<{ id: string }> };

/**
 * Record the metadata of an audio file the browser just produced.
 *
 * Only metadata is stored: audio bytes stay in the tab as object URLs unless a
 * Supabase Storage key is configured, so this endpoint never receives blobs.
 */
export async function POST(request: Request, ctx: ProjectRouteContext): Promise<NextResponse> {
  try {
    const { id } = await ctx.params;
    const body = await readJsonObject(request);
    if (!body) return jsonError("Expected a JSON object body.", 400);

    const parsed = audioAssetSchema.safeParse(body);
    if (!parsed.success) return jsonError(describeZodError(parsed.error), 400);

    await recordAudioAsset(id, parsed.data);
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
