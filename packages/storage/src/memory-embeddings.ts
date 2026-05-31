import { createHash } from "node:crypto";

// Summarizes large tool output before storing the full body behind an artifact ref.
export function summarizeArtifactOutput(
  toolName: string,
  output: string,
): string {
  const compact = output.replace(/\s+/gu, " ").trim();
  const summary =
    compact.length > 500 ? compact.slice(0, 500).trimEnd() : compact;
  return summary.length === 0
    ? `${toolName} produced an empty large output.`
    : summary;
}

// Reads both Ollama /api/embed response shapes used by recent versions.
export function readOllamaEmbedding(payload: unknown): number[] | null {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const embeddings = record.embeddings;
  if (Array.isArray(embeddings) && Array.isArray(embeddings[0])) {
    return readNumberVector(embeddings[0]);
  }
  return readNumberVector(record.embedding);
}

// Reads OpenAI-compatible embedding responses from /v1/embeddings.
export function readOpenAICompatibleEmbedding(
  payload: unknown,
): number[] | null {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const data = record.data;
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0];
    if (first !== null && typeof first === "object" && !Array.isArray(first)) {
      return readNumberVector((first as Record<string, unknown>).embedding);
    }
  }
  return readNumberVector(record.embedding);
}

// Reads Hugging Face feature-extraction responses as either pooled or token vectors.
export function readHuggingFaceEmbedding(payload: unknown): number[] | null {
  const directVector = readNumberVector(payload);
  if (directVector !== null) {
    return directVector;
  }
  if (!Array.isArray(payload) || payload.length === 0) {
    return null;
  }
  const first = payload[0];
  const firstVector = readNumberVector(first);
  if (firstVector !== null) {
    return firstVector;
  }
  if (!Array.isArray(first)) {
    return null;
  }
  return averageVectors(first.map((item) => readNumberVector(item)));
}

// Creates a deterministic local embedding from token hashes so smoke tests never need a model download.
export function createLocalHashEmbedding(
  text: string,
  dimensions = 128,
): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  const tokens = tokenizeForLocalEmbedding(text);
  for (const token of tokens) {
    const digest = createHash("sha256").update(token).digest();
    const index = digest.readUInt32BE(0) % dimensions;
    vector[index] += 1;
  }
  return normalizeVector(vector);
}

// Removes a trailing slash before appending provider-specific endpoint paths.
export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

// Computes cosine similarity for vectors returned by the same embedding model.
export function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

// Validates one embedding vector before storing it as Float32 bytes.
function readNumberVector(value: unknown): number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const vector = value.filter(
    (item): item is number => typeof item === "number" && Number.isFinite(item),
  );
  return vector.length === value.length && vector.length > 0 ? vector : null;
}

// Pools token-level embeddings into one document vector.
function averageVectors(vectors: Array<number[] | null>): number[] | null {
  const validVectors = vectors.filter(
    (vector): vector is number[] => vector !== null,
  );
  if (validVectors.length === 0) {
    return null;
  }
  const dimensions = Math.min(...validVectors.map((vector) => vector.length));
  if (dimensions === 0) {
    return null;
  }
  const average = Array.from({ length: dimensions }, () => 0);
  for (const vector of validVectors) {
    for (let index = 0; index < dimensions; index += 1) {
      average[index] += vector[index] ?? 0;
    }
  }
  return average.map((value) => value / validVectors.length);
}

// Splits text into stable lexical units for the no-download local embedding provider.
function tokenizeForLocalEmbedding(text: string): string[] {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu);
  if (tokens !== null && tokens.length > 0) {
    return tokens;
  }
  const compact = text.trim();
  return compact.length === 0 ? [""] : [...compact];
}

// Normalizes a vector for cosine scoring while preserving all-zero fallback vectors.
function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    return vector;
  }
  return vector.map((value) => value / norm);
}
