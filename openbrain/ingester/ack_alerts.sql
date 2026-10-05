-- Parameters: JSON array of {id, lease_token}, SMTP message ID.
-- An old worker cannot acknowledge another worker's replacement lease.
WITH acknowledged AS (
    UPDATE public.report_email_delivery d
       SET sent_at = now(), smtp_message_id = $2
      FROM jsonb_to_recordset($1::jsonb) AS sent(id uuid, lease_token uuid)
     WHERE d.report_id = sent.id AND d.lease_token = sent.lease_token
       AND d.sent_at IS NULL
    RETURNING d.report_id
)
SELECT count(*)::integer AS acknowledged FROM acknowledged;
