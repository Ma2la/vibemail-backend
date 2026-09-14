import { Message, MessageStatus } from './message';

// ── OAuth token shape ────────────────────────────────────────────────────────

export interface OAuthTokens {
  accessToken:  string;
  refreshToken: string;
  expiresAt?:   number;   // Unix timestamp in ms
}

// ── listMessages ─────────────────────────────────────────────────────────────

export interface ListMessagesOptions {
  cursor?:  string;   // opaque pagination cursor (Gmail pageToken equivalent)
  limit?:   number;   // default 20, max 100
  labelId?: string;   // filter by provider label ID (e.g. "INBOX")
}

export interface ListMessagesResult {
  messages:   Message[];
  nextCursor: string | null;   // null when no further pages exist
}

// ── sendMessage ──────────────────────────────────────────────────────────────

export interface SendMessageOptions {
  to:        string;
  subject:   string;
  body:      string;
  threadId?: string;   // omit for new compose; include for threaded reply
}

// ── updateMessageState ────────────────────────────────────────────────────────

export interface UpdateMessageStateOptions {
  read?:     boolean;   // true → mark read; false → mark unread
  starred?:  boolean;   // true → star; false → unstar
  archived?: boolean;   // true → archive (remove from inbox); false → unarchive
  trashed?:  boolean;   // true → move to trash; false → restore from trash
}

export interface UpdateMessageStateResult {
  id:        string;
  isRead:    boolean;
  isStarred: boolean;
  status:    MessageStatus;   // derived server-side, never client-supplied
}

// ── Error ────────────────────────────────────────────────────────────────────

export class ProviderError extends Error {
  constructor(
    public readonly code: string,      // SCREAMING_SNAKE_CASE — matches CONTRACT.md error codes
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

// ── Provider interface ───────────────────────────────────────────────────────

export interface EmailProvider {
  // OAuth flow
  initiateOAuth(): Promise<{ url: string; state: string }>;
  exchangeCode(code: string, state?: string): Promise<OAuthTokens & { userId: string; email: string; name: string }>;
  refreshAccessToken(userId: string): Promise<OAuthTokens>;

  // Messages
  listMessages(options: ListMessagesOptions): Promise<ListMessagesResult>;
  sendMessage(options: SendMessageOptions): Promise<Message>;
  updateMessageState(messageId: string, options: UpdateMessageStateOptions): Promise<UpdateMessageStateResult>;
}
