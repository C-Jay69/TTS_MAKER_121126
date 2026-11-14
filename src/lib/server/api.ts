/**
 * Small helpers shared by the JSON route handlers.
 */

import { NextResponse } from "next/server";
import type { ZodError } from "zod";

import { ProjectConflictError, ProjectNotFoundError } from "@/lib/server/projects";

export function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export function describeZodError(error: ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

/** Read and shape a JSON body, rejecting anything that is not an object. */
export async function readJsonObject(request: Request): Promise<unknown | null> {
  try {
    const body = await request.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
    return body;
  } catch {
    return null;
  }
}

export function handleRouteError(error: unknown): NextResponse {
  if (error instanceof ProjectNotFoundError) return jsonError(error.message, 404);
  if (error instanceof ProjectConflictError) return jsonError(error.message, 409);

  // Prisma connectivity problems are the most likely runtime failure here
  // (Supabase paused, wrong password, IPv6-only network).
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  console.error("[api/projects]", error);
  if (/connect|ECONNREFUSED|ETIMEDOUT|authentication failed|does not exist/i.test(message)) {
    return jsonError(
      "Cannot reach the Postgres database. Check DATABASE_URL and that the Supabase project is awake.",
      503,
    );
  }
  return jsonError(message, 500);
}
