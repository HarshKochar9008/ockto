// Hybrid search: pgvector nearest neighbours + Postgres full-text, fused with
// reciprocal rank fusion. Always scoped to one workspace.
import { inTransaction } from './db.ts';

export interface Hit {
  chunk_id: string; document_id: string; filename: string; role: 'requirements' | 'evidence';
  classification: string | null; expiry_date: string | null; page_number: number | null; content: string; score: number;
}

/** OR of the query's words, so a long requirement still matches passages that share a few terms. */
export function keywordQuery(q: string): string {
  const words = [...new Set(q.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 24);
  return words.join(' or ');
}

export async function hybridSearch(opts: {
  workspaceId: string; query: string; embedding: number[]; limit?: number; roles?: ('requirements' | 'evidence')[];
}): Promise<Hit[]> {
  const { workspaceId, query, embedding, limit = 6, roles = ['evidence'] } = opts;
  return inTransaction(async (db) => {
    // HNSW returns the global top-k before the workspace filter; iterative scans
    // keep going until enough rows from *this* workspace are found (pgvector 0.8+).
    await db.query(`SET LOCAL hnsw.iterative_scan = relaxed_order`);
    const { rows } = await db.query<Hit>(
      `WITH vec AS (
         SELECT id, row_number() OVER (ORDER BY dist) AS rank FROM (
           SELECT c.id, c.embedding <=> $2::vector AS dist
           FROM document_chunks c JOIN documents d ON d.id = c.document_id
           WHERE c.workspace_id = $1 AND d.role = ANY($4)
           ORDER BY dist LIMIT 30) v
       ), kw AS (
         SELECT id, row_number() OVER (ORDER BY score DESC) AS rank FROM (
           SELECT c.id, ts_rank_cd(c.tsv, q) AS score
           FROM document_chunks c JOIN documents d ON d.id = c.document_id,
                websearch_to_tsquery('english', $3) q
           WHERE c.workspace_id = $1 AND d.role = ANY($4) AND c.tsv @@ q
           ORDER BY score DESC LIMIT 30) k
       ), fused AS (
         SELECT id, sum(1.0 / (60 + rank)) AS score FROM (SELECT * FROM vec UNION ALL SELECT * FROM kw) u GROUP BY id
       )
       SELECT c.id AS chunk_id, c.document_id, d.filename, d.role, d.classification, d.expiry_date,
              c.page_number, c.content, f.score::float8 AS score
       FROM fused f JOIN document_chunks c ON c.id = f.id JOIN documents d ON d.id = c.document_id
       ORDER BY f.score DESC LIMIT $5`,
      [workspaceId, JSON.stringify(embedding), keywordQuery(query), roles, limit],
    );
    return rows;
  });
}
