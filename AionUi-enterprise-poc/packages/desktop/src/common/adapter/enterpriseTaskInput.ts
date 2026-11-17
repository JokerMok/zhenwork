// Match Web Host's admission limits. The server remains authoritative.
const CONTENT_LIMIT = 64_000;
const REQUEST_LIMIT = 128_000;

type MessageBody = {
  content: string;
  files?: unknown;
  sessions?: unknown;
  inject_skills?: unknown;
  request_id?: string;
};

export function enterpriseTaskInputTooLarge(body: MessageBody): boolean {
  if (body.content.length > CONTENT_LIMIT) return true;
  const normalized = {
    content: body.content,
    files: body.files || [],
    sessions: body.sessions || [],
    inject_skills: body.inject_skills || [],
  };
  if (JSON.stringify(normalized).length > REQUEST_LIMIT) return true;
  const wire = { ...body, request_id: body.request_id || '00000000-0000-0000-0000-000000000000' };
  return new TextEncoder().encode(JSON.stringify(wire)).byteLength > REQUEST_LIMIT;
}
