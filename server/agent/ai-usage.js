// Append-only usage ledger for Pi turns: tokens, cache hits and cost.
//
// One JSON object per line so the file stays inspectable; aggregates are
// computed on read for the manual AI configuration page.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_BYTES = 2 * 1024 * 1024;

export function summarizeUsage(entries = []) {
  const totals = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    estimatedCostEntries: 0
  };
  const byModel = new Map();
  for (const entry of entries) {
    const input = Number(entry.inputTokens) || 0;
    const output = Number(entry.outputTokens) || 0;
    const cacheRead = Number(entry.cacheReadTokens) || 0;
    const cacheWrite = Number(entry.cacheWriteTokens) || 0;
    // `null`/missing means "the provider did not report a price", which is not
    // the same as a zero-cost turn.
    const rawCost = entry.costUsd;
    const cost = rawCost === null || rawCost === undefined || rawCost === "" ? NaN : Number(rawCost);
    totals.turns += 1;
    totals.inputTokens += input;
    totals.outputTokens += output;
    totals.cacheReadTokens += cacheRead;
    totals.cacheWriteTokens += cacheWrite;
    totals.totalTokens += input + output;
    if (Number.isFinite(cost)) totals.costUsd += cost;
    else totals.estimatedCostEntries += 1;

    const key = `${entry.provider || "?"}/${entry.model || "?"}`;
    const bucket = byModel.get(key) || { provider: entry.provider || "", model: entry.model || "", turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    bucket.turns += 1;
    bucket.inputTokens += input;
    bucket.outputTokens += output;
    if (Number.isFinite(cost)) bucket.costUsd += cost;
    byModel.set(key, bucket);
  }
  totals.costUsd = Number(totals.costUsd.toFixed(6));
  return {
    ...totals,
    byModel: [...byModel.values()]
      .map((bucket) => ({ ...bucket, costUsd: Number(bucket.costUsd.toFixed(6)) }))
      .sort((first, second) => second.inputTokens + second.outputTokens - (first.inputTokens + first.outputTokens))
  };
}

export function createAiUsageLedger({
  filePath = path.join(os.homedir(), ".config", "device-operate", "ai-usage.jsonl"),
  maxBytes = MAX_BYTES
} = {}) {
  async function readLines() {
    try {
      const stat = await fs.stat(filePath);
      const start = Math.max(0, stat.size - maxBytes);
      const handle = await fs.open(filePath, "r");
      try {
        const buffer = Buffer.alloc(stat.size - start);
        await handle.read(buffer, 0, buffer.length, start);
        const lines = buffer.toString("utf8").split("\n");
        if (start > 0) lines.shift();
        return lines.filter(Boolean);
      } finally {
        await handle.close();
      }
    } catch {
      return [];
    }
  }

  return {
    filePath,
    async record(entry) {
      const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, `${line}\n`, "utf8");
      return entry;
    },
    async summary() {
      const entries = [];
      for (const line of await readLines()) {
        try {
          entries.push(JSON.parse(line));
        } catch {
          // ignore a partially written line
        }
      }
      return { ...summarizeUsage(entries), filePath, recent: entries.slice(-20).reverse() };
    }
  };
}
