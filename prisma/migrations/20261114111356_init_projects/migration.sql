-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceName" TEXT,
    "sourceSize" INTEGER,
    "manuscript" TEXT NOT NULL,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "engine" TEXT NOT NULL,
    "voice" TEXT NOT NULL,
    "model" TEXT,
    "speed" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chunk" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "duration" DOUBLE PRECISION,
    "byteSize" INTEGER,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudioAsset" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "chunkId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'chunk',
    "mimeType" TEXT NOT NULL DEFAULT 'audio/wav',
    "byteSize" INTEGER NOT NULL,
    "duration" DOUBLE PRECISION NOT NULL,
    "sampleRate" INTEGER NOT NULL DEFAULT 24000,
    "channels" INTEGER NOT NULL DEFAULT 1,
    "engine" TEXT NOT NULL,
    "voice" TEXT NOT NULL,
    "storage" TEXT NOT NULL DEFAULT 'browser',
    "storagePath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AudioAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Project_updatedAt_idx" ON "Project"("updatedAt" DESC);

-- CreateIndex
CREATE INDEX "Chunk_projectId_status_idx" ON "Chunk"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Chunk_projectId_index_key" ON "Chunk"("projectId", "index");

-- CreateIndex
CREATE INDEX "AudioAsset_projectId_createdAt_idx" ON "AudioAsset"("projectId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "Chunk" ADD CONSTRAINT "Chunk_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioAsset" ADD CONSTRAINT "AudioAsset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioAsset" ADD CONSTRAINT "AudioAsset_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "Chunk"("id") ON DELETE SET NULL ON UPDATE CASCADE;
