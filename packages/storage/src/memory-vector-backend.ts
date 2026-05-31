export type MemoryVectorRecord = {
  contentHash: string;
  embeddingModel: string;
  vector: number[];
};

export type MemoryVectorBackend = {
  read(contentHash: string, embeddingModel: string): Promise<number[] | null>;
  write(record: MemoryVectorRecord): Promise<void>;
};
