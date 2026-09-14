import { google } from 'googleapis';
import { loadOAuth2Client } from '../providers/gmail/auth';
import { SendMessageOptions, ProviderError } from '../types/provider';
import { Message } from '../types/message';
import { normalizeMessage, upsertMessages, getHeader } from '../sync/normalize';

// ── Reply threading headers ──────────────────────────────────────────────────

/**
 * Per the Gmail API's own documented threadId requirements, adding a message
 * to an existing thread needs its raw RFC 2822 form to carry In-Reply-To and
 * References headers pointing at the thread's most recent message — passing
 * threadId in the request body alone is not sufficient. Returns null when the
 * thread's last message has no Message-ID header to reply to (fall back to
 * sending without these headers rather than failing the whole send).
 */
async function getReplyHeaders(
  gmail:    ReturnType<typeof google.gmail>,
  threadId: string,
): Promise<{ inReplyTo: string; references: string } | null> {
  let thread;
  try {
    ({ data: thread } = await gmail.users.threads.get({
      userId:          'me',
      id:              threadId,
      format:          'metadata',
      metadataHeaders: ['Message-ID', 'References'],
    }));
  } catch (err) {
    const status = (err as Record<string, unknown>).status ?? (err as Record<string, unknown>).code;
    if (status === 404) {
      throw new ProviderError('THREAD_NOT_FOUND', `No thread found for threadId "${threadId}"`, err);
    }
    throw err;
  }

  const lastMessage = thread.messages?.[thread.messages.length - 1];
  const headers = lastMessage?.payload?.headers ?? [];

  const messageId = getHeader(headers, 'Message-ID');
  if (!messageId) return null;

  const existingReferences = getHeader(headers, 'References');
  const references = existingReferences ? `${existingReferences} ${messageId}` : messageId;

  return { inReplyTo: messageId, references };
}

// ── RFC 2822 construction ────────────────────────────────────────────────────

/**
 * Builds a minimal RFC 2822 message string and returns it base64url-encoded,
 * ready for the Gmail API `raw` field.
 *
 * Line endings are \r\n per RFC 2822 §2.1.
 * The blank line between headers and body is required by the spec.
 */
function buildRaw(
  from:         string,
  options:      SendMessageOptions,
  replyHeaders: { inReplyTo: string; references: string } | null,
): string {
  const headers = [
    `From: ${from}`,
    `To: ${options.to}`,
    `Subject: ${options.subject}`,
    ...(replyHeaders ? [`In-Reply-To: ${replyHeaders.inReplyTo}`, `References: ${replyHeaders.references}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ].join('\r\n');

  const message = `${headers}\r\n\r\n${options.body}`;
  return Buffer.from(message).toString('base64url');
}

// ── Send ─────────────────────────────────────────────────────────────────────

/**
 * Sends an email via the Gmail API on behalf of the authenticated user,
 * then fetches the full sent message, normalizes it to the Message shape
 * (mapping from_address / to_address for the DB schema), and upserts it
 * to Supabase.
 *
 * Returns the full normalized Message as it was stored.
 */
export async function sendMessage(
  userId: string,
  options: SendMessageOptions,
): Promise<Message> {
  const auth  = await loadOAuth2Client(userId);
  const gmail = google.gmail({ version: 'v1', auth });

  // Fetch sender address for the RFC 2822 From header.
  const { data: profile } = await gmail.users.getProfile({ userId: 'me' });
  const from = profile.emailAddress;
  if (!from) {
    throw new ProviderError(
      'GMAIL_SEND_FAILED',
      'Could not retrieve sender email address from Gmail profile',
    );
  }

  // When replying in-thread, the raw message must carry In-Reply-To/References
  // pointing at the thread's last message — see getReplyHeaders' doc comment.
  const replyHeaders = options.threadId
    ? await getReplyHeaders(gmail, options.threadId)
    : null;

  // Build and encode the RFC 2822 message.
  const raw = buildRaw(from, options, replyHeaders);

  // Send via Gmail API.
  let sentId: string;
  try {
    const { data: sent } = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw,
        ...(options.threadId ? { threadId: options.threadId } : {}),
      },
    });

    if (!sent.id) {
      throw new ProviderError(
        'GMAIL_SEND_FAILED',
        'Gmail did not return a message ID after send',
      );
    }
    sentId = sent.id;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError('GMAIL_SEND_FAILED', 'Gmail messages.send failed', err);
  }

  // Fetch the full sent message so we have headers and body for normalization.
  // messages.send returns a partial Message — payload may be empty.
  const { data: fullMsg } = await gmail.users.messages.get({
    userId: 'me',
    id:     sentId,
    format: 'FULL',
  });

  // Normalize to Message shape.
  // normalizeMessage extracts from/to headers and maps them;
  // upsertMessages maps them to from_address / to_address in the DB row.
  const normalized = normalizeMessage(fullMsg, userId);
  await upsertMessages([normalized]);

  // Return the full Message record.
  // id is set to gmailId per CONTRACT.md §3; timestamps are Supabase-managed
  // and approximated here since the upsert does not return the inserted row.
  return {
    ...normalized,
    id:        fullMsg.id ?? sentId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
