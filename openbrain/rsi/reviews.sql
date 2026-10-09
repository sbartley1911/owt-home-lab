-- Administrator read-only report. Old observations and human dispositions remain visible.
SELECT source,doc_ref,reason,status,first_seen,last_seen,
       evidence->>'affected_chunks' AS affected_chunks,
       evidence->>'chunk_count' AS total_chunks,
       evidence->'sample_entry_ids' AS sample_entry_ids,
       evidence->>'window_start' AS window_start,
       evidence->>'window_end' AS window_end
FROM rsi.defect_reviews
WHERE status='open'
ORDER BY CASE reason WHEN 'garbled_chunks' THEN 0 WHEN 'short_chunks' THEN 1 ELSE 2 END,
         last_seen DESC,source,doc_ref;

SELECT * FROM rsi.defect_scans ORDER BY scanned_at DESC LIMIT 10;
