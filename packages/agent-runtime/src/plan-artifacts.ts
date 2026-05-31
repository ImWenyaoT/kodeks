import type { StoredPlanStep } from "@kodeks/storage";

// Extracts a minimal structured plan from the assistant's plan-mode answer.
export function buildPlanArtifactContent(
  userPrompt: string,
  assistantText: string,
): {
  title: string;
  summary: string;
  steps: StoredPlanStep[];
} {
  const lines = assistantText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const title =
    readPlanTitle(lines) ?? compactText(userPrompt, 80) ?? "Kodeks plan";
  const summary =
    readPlanSummary(lines, title) ?? compactText(assistantText, 240);
  const steps = readPlanSteps(lines);
  return {
    title,
    summary,
    steps:
      steps.length > 0
        ? steps
        : [
            {
              id: "step_1",
              title: summary || "Review the generated plan",
              status: "pending",
              details: null,
            },
          ],
  };
}

// Reads a markdown heading or the first short non-list line as a plan title.
function readPlanTitle(lines: string[]): string | null {
  const heading = lines.find((line) => /^#{1,3}\s+/u.test(line));
  if (heading !== undefined) {
    return heading.replace(/^#{1,3}\s+/u, "").trim();
  }
  const firstText = lines.find((line) => !isPlanStepLine(line));
  return firstText === undefined
    ? null
    : compactText(firstText.replace(/[:：]$/u, ""), 80);
}

// Reads a concise summary line while skipping headings and step-like bullets.
function readPlanSummary(lines: string[], title: string): string | null {
  const summary = lines.find((line) => {
    const normalized = line.replace(/^#{1,3}\s+/u, "").trim();
    return (
      normalized !== title &&
      !isPlanStepLine(line) &&
      !/^(summary|摘要|计划|steps|步骤)[:：]?$/iu.test(normalized)
    );
  });
  return summary === undefined ? null : compactText(summary, 240);
}

// Extracts numbered, bulleted, or checkbox lines as structured plan steps.
function readPlanSteps(lines: string[]): StoredPlanStep[] {
  return lines
    .flatMap((line) => {
      const match = line.match(
        /^(?:[-*]\s+(?:\[[ xX]\]\s*)?|\d+[.)、]\s+)(.+)$/u,
      );
      if (match === null) {
        return [];
      }
      const title = compactText(
        match[1]?.replace(/^[-*]\s*/u, "").trim() ?? "",
        160,
      );
      if (title.length === 0) {
        return [];
      }
      const status: StoredPlanStep["status"] =
        line.includes("[x]") || line.includes("[X]") ? "completed" : "pending";
      return [{ id: "", title, status, details: null }];
    })
    .map((step, index) => ({ ...step, id: `step_${index + 1}` }));
}

// Checks whether a line looks like a markdown/list plan step.
function isPlanStepLine(line: string): boolean {
  return /^(?:[-*]\s+(?:\[[ xX]\]\s*)?|\d+[.)、]\s+)/u.test(line);
}

// Collapses whitespace and trims long model text for stable artifact fields.
function compactText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd();
}
