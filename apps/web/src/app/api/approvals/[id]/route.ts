import type { NextRequest } from "next/server";

import {
  ApprovalAlreadyResolvedError,
  ApprovalNotFoundError,
} from "@kodeks/storage";
import {
  ShellCommandTimeoutError,
  runApprovedCommand,
} from "@kodeks/workspace";

import {
  getKodeksDatabase,
  getKodeksWorkspace,
} from "@/lib/server/kodeks-runtime";

// Next.js API routes 需要 Node runtime 以访问本地文件系统和 SQLite。
export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

// 按 id 读取一个 approval record。
export async function GET(
  _request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const { id } = await context.params;
  try {
    const approval = await getKodeksDatabase().approvals.getApproval(id);
    return Response.json({ approval });
  } catch (error) {
    return approvalErrorResponse(error);
  }
}

// 批准或拒绝一个 pending approval；批准后的 shell command 只会执行一次。
export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const decision = parseApprovalDecision(body.decision);
  if (decision === null) {
    return Response.json(
      { error: 'Invalid decision. Expected "approve" or "reject".' },
      { status: 400 },
    );
  }
  const database = getKodeksDatabase();

  try {
    if (decision === "reject") {
      const approval = await database.approvals.reject(
        id,
        typeof body.reason === "string" && body.reason.trim()
          ? body.reason.trim()
          : "Rejected by user",
      );
      await database.auditLog.record({
        sessionId: approval.sessionId,
        eventType: "approval_rejected",
        payload: { approvalId: approval.id },
      });
      return Response.json({ approval });
    }

    const pendingApproval = await database.approvals.getApproval(id);
    const command = extractApprovedCommand(pendingApproval.command);
    if (command === null) {
      return Response.json(
        { error: "Approval does not contain an executable command." },
        { status: 400 },
      );
    }

    const approved = await database.approvals.approve(id);
    const result = await runApprovedCommand(command, {
      cwd: getKodeksWorkspace().rootPath(),
    });
    const executed = await database.approvals.markExecuted(id);
    await database.auditLog.record({
      sessionId: approved.sessionId,
      eventType: "approval_executed",
      payload: {
        approvalId: approved.id,
        command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    });

    return Response.json({ approval: executed, result });
  } catch (error) {
    if (error instanceof ShellCommandTimeoutError) {
      return Response.json({ error: error.message }, { status: 408 });
    }
    return approvalErrorResponse(error);
  }
}

// Parses an explicit approval decision value.
export function parseApprovalDecision(
  decision: unknown,
): "approve" | "reject" | null {
  if (decision === "approve" || decision === "reject") {
    return decision;
  }
  return null;
}

// Extracts the command string from a structured approval payload.
function extractApprovedCommand(command: unknown): string | null {
  if (
    command !== null &&
    typeof command === "object" &&
    "command" in command &&
    typeof (command as { command?: unknown }).command === "string" &&
    (command as { command: string }).command.trim().length > 0
  ) {
    return (command as { command: string }).command.trim();
  }
  return null;
}

// Maps approval domain errors into HTTP responses.
function approvalErrorResponse(error: unknown): Response {
  if (error instanceof ApprovalNotFoundError) {
    return Response.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof ApprovalAlreadyResolvedError) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  return Response.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: 500 },
  );
}
