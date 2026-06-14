import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { URLSearchParams } from "node:url";
import { captureThought, createPool, requireCaptureToken, type CaptureInput } from "./openbrain.js";

const pool = createPool();
const port = Number(process.env.OPENBRAIN_CAPTURE_PORT ?? "8787");

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET") {
      const verified = verifyWhatsAppWebhook(req.url ?? "");
      res.writeHead(verified.status, { "content-type": verified.contentType });
      res.end(verified.body);
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed." });
      return;
    }

    const rawBody = await readBody(req);
    await requireAllowedSender(req, rawBody);
    const captures = parseCaptures(req, rawBody);
    const captured = [];

    for (const capture of captures) {
      captured.push(await captureThought(pool, capture));
    }

    sendJson(res, 200, { ok: true, captured });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, { error: message });
  }
});

server.listen(port, () => {
  console.error(`OpenBrain capture server listening on :${port}`);
});

async function requireAllowedSender(req: IncomingMessage, rawBody: string) {
  const signature = req.headers["x-hub-signature-256"];
  if (typeof signature === "string") {
    verifyMetaSignature(signature, rawBody);
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const headerToken = req.headers["x-openbrain-token"];
  const token = typeof headerToken === "string" ? headerToken : url.searchParams.get("token");
  requireCaptureToken(token);
}

function parseCaptures(req: IncomingMessage, rawBody: string): CaptureInput[] {
  const contentType = req.headers["content-type"] ?? "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(rawBody);
    return [{
      content: form.get("text") ?? "",
      source: "slack",
      sourceRef: form.get("channel_id") ?? undefined,
      metadata: {
        user_id: form.get("user_id"),
        channel_name: form.get("channel_name"),
        command: form.get("command")
      }
    }];
  }

  if (contentType.includes("application/json")) {
    const body = JSON.parse(rawBody);
    if (body.object === "whatsapp_business_account") return extractWhatsAppCaptures(body);
    return [{
      content: body.content ?? body.text ?? "",
      source: body.source,
      sourceRef: body.sourceRef ?? body.source_ref,
      metadata: body.metadata,
      people: body.people,
      topics: body.topics,
      entryType: body.entryType ?? body.entry_type
    }];
  }

  return [{ content: rawBody, source: "manual" }];
}

function extractWhatsAppCaptures(body: Record<string, any>): CaptureInput[] {
  const captures: CaptureInput[] = [];

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const phoneNumberId = value.metadata?.phone_number_id;

      for (const message of value.messages ?? []) {
        if (message.type !== "text") continue;
        const content = message.text?.body?.trim();
        if (!content) continue;

        captures.push({
          content,
          source: "whatsapp",
          // Use Meta's message id for idempotency. Meta retries on 5xx;
          // (source, source_ref) UNIQUE turns retries into no-ops.
          sourceRef: message.id,
          metadata: {
            provider: "meta_whatsapp_cloud_api",
            from: message.from,
            timestamp: message.timestamp,
            phone_number_id: phoneNumberId,
            contacts: value.contacts ?? []
          }
        });
      }
    }
  }

  return captures;
}

function verifyWhatsAppWebhook(requestUrl: string) {
  const url = new URL(requestUrl, "http://localhost");
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN && challenge) {
    return { status: 200, contentType: "text/plain", body: challenge };
  }

  return { status: 403, contentType: "text/plain", body: "Forbidden" };
}

function verifyMetaSignature(signature: string, rawBody: string) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) throw new Error("WHATSAPP_APP_SECRET is required to verify Meta webhook signatures.");

  const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(signature);

  if (expectedBytes.length !== actualBytes.length || !timingSafeEqual(expectedBytes, actualBytes)) {
    throw new Error("Invalid Meta signature.");
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: { writeHead: Function; end: Function }, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}
