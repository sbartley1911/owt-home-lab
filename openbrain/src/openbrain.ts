import pg from "pg";

const { Pool } = pg;

export type BrainEntry = {
  id: string;
  content: string;
  source: string;
  source_ref?: string | null;
  metadata: Record<string, unknown>;
  people: string[];
  topics: string[];
  entry_type: string;
  captured_at: string;
  similarity?: number;
};

export type CaptureInput = {
  content: string;
  source?: string;
  sourceRef?: string;
  metadata?: Record<string, unknown>;
  people?: string[];
  topics?: string[];
  entryType?: string;
};

const embeddingModel = process.env.OPENBRAIN_EMBEDDING_MODEL ?? "text-embedding-3-small";

export function createPool(): pg.Pool {
  return new Pool({
    connectionString: requiredEnv("DATABASE_URL"),
    max: Number(process.env.OPENBRAIN_DB_POOL_SIZE ?? "5")
  });
}

export async function embedText(input: string): Promise<number[]> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      authorization: `Bearer ${requiredEnv("OPENAI_API_KEY")}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: embeddingModel,
      input,
      encoding_format: "float"
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI embedding request failed (${response.status}): ${body}`);
  }

  const json = await response.json() as { data?: Array<{ embedding?: number[] }> };
  const embedding = json.data?.[0]?.embedding;
  if (!embedding) {
    throw new Error("OpenAI embedding response did not include an embedding.");
  }
  return embedding;
}

export async function captureThought(pool: pg.Pool, input: CaptureInput): Promise<BrainEntry> {
  const normalized = normalizeCapture(input);
  const sourceRef = normalized.sourceRef || null;

  // Fast path: if this (source, source_ref) is already captured, return it
  // without spending an embedding API call. Skip lookup when source_ref is null
  // (NULLs are not deduped, so every null is a new row).
  if (sourceRef) {
    const existing = await pool.query<BrainEntry>(
      `select id, content, source, source_ref, metadata, people, topics, entry_type, captured_at
       from public.brain_entries where source = $1 and source_ref = $2 limit 1`,
      [normalized.source, sourceRef]
    );
    if (existing.rows[0]) return existing.rows[0];
  }

  const embedding = await embedText(normalized.content);
  const result = await pool.query<BrainEntry>(
    `
      insert into public.brain_entries (
        content,
        source,
        source_ref,
        embedding,
        metadata,
        people,
        topics,
        entry_type
      )
      values ($1, $2, $3, $4::vector, $5::jsonb, $6::text[], $7::text[], $8)
      on conflict on constraint brain_entries_source_unique do nothing
      returning id, content, source, source_ref, metadata, people, topics, entry_type, captured_at
    `,
    [
      normalized.content,
      normalized.source,
      sourceRef,
      vectorLiteral(embedding),
      JSON.stringify(normalized.metadata),
      normalized.people,
      normalized.topics,
      normalized.entryType
    ]
  );

  if (result.rows[0]) return result.rows[0];

  // Lost the insert race (concurrent webhook retry) — re-read the winning row.
  const winner = await pool.query<BrainEntry>(
    `select id, content, source, source_ref, metadata, people, topics, entry_type, captured_at
     from public.brain_entries where source = $1 and source_ref = $2 limit 1`,
    [normalized.source, sourceRef]
  );
  if (!winner.rows[0]) throw new Error("Insert blocked by conflict but no existing row found.");
  return winner.rows[0];
}

export async function semanticSearch(
  pool: pg.Pool,
  query: string,
  matchCount: number,
  source?: string
): Promise<BrainEntry[]> {
  const embedding = await embedText(query);
  const result = await pool.query<BrainEntry>(
    `
      select *
      from public.match_brain_entries($1::vector, $2::int, $3::text)
    `,
    [vectorLiteral(embedding), matchCount, source ?? null]
  );

  return result.rows;
}

export async function recentEntries(pool: pg.Pool, limit: number, source?: string): Promise<BrainEntry[]> {
  const result = await pool.query<BrainEntry>(
    `
      select id, content, source, source_ref, metadata, people, topics, entry_type, captured_at
      from public.brain_entries
      where ($2::text is null or source = $2)
      order by captured_at desc
      limit $1
    `,
    [Math.max(1, Math.min(limit, 50)), source ?? null]
  );

  return result.rows;
}

export async function brainStats(pool: pg.Pool): Promise<Record<string, unknown>> {
  const result = await pool.query<{ brain_stats: Record<string, unknown> }>("select public.brain_stats()");
  return result.rows[0]?.brain_stats ?? {};
}

export function normalizeCapture(input: CaptureInput): Required<CaptureInput> {
  const content = input.content.trim();
  if (!content) throw new Error("Content is required.");

  const metadata = input.metadata ?? inferMetadata(content);
  return {
    content,
    source: input.source?.trim() || "manual",
    sourceRef: input.sourceRef?.trim() || "",
    metadata,
    people: dedupe(input.people ?? extractPeople(content)),
    topics: dedupe(input.topics ?? extractTopics(content)),
    entryType: input.entryType?.trim() || inferEntryType(content)
  };
}

export function requireCaptureToken(token: string | null | undefined) {
  if (token !== requiredEnv("OPENBRAIN_CAPTURE_TOKEN")) {
    throw new Error("Invalid capture token.");
  }
}

export function vectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

function inferMetadata(content: string): Record<string, unknown> {
  return {
    inferred: true,
    length: content.length,
    has_question: content.includes("?")
  };
}

function inferEntryType(content: string): string {
  const lower = content.toLowerCase();
  if (lower.includes("decided") || lower.startsWith("decision:")) return "decision";
  if (lower.includes("todo") || lower.includes("follow up") || lower.includes("action:")) return "action";
  if (lower.includes("met with") || lower.includes("meeting")) return "meeting";
  if (lower.includes("realized") || lower.includes("insight:")) return "insight";
  return "thought";
}

function extractPeople(content: string): string[] {
  const matches = content.match(/\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)?\b/g) ?? [];
  const ignored = new Set(["I", "The", "A", "An", "OpenAI", "Postgres", "Supabase", "MCP"]);
  return matches.filter((name) => !ignored.has(name));
}

function extractTopics(content: string): string[] {
  const lower = content.toLowerCase();
  const topics = [
    "career",
    "consulting",
    "product",
    "ai",
    "agent",
    "writing",
    "meeting",
    "decision",
    "health",
    "finance",
    "relationship",
    "project"
  ];
  return topics.filter((topic) => lower.includes(topic));
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 20);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
