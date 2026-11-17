// Conversations (email threads) from message summaries.
//
// Messages are linked through their headers (Message-ID, In-Reply-To, References),
// the way RFC 5322 intends and mail clients like Outlook/Thunderbird do: a union-find over
// every id a message mentions. Because References lists the whole ancestry, a chain stays
// linked even when an intermediate message (e.g. your reply, which lives in Sent) isn't
// in the folder being shown. A conservative subject fallback catches replies from clients
// that drop the headers. Threads never cross accounts.

const REPLY_PREFIX = /^\s*((re|fw|fwd|aw|sv|wg|antw|rif|r|tr|vs|ref|res|enc|odp|πρ|回复|转发)(\s*\[\d+\])?\s*[:：]\s*)+/i;
const DAY = 86400000;

/** Subject without reply/forward prefixes, lowercased, whitespace collapsed. */
export function normSubject(s) {
  return String(s || "").replace(REPLY_PREFIX, "").replace(/\s+/g, " ").trim().toLowerCase();
}
export const isReplySubject = (s) => REPLY_PREFIX.test(String(s || ""));

const strip = (id) => String(id || "").trim().replace(/^<|>$/g, "").trim();
const emailsOf = (m) => [m.from?.email, ...(m.to || []).map((p) => p.email)].filter(Boolean).map((e) => e.toLowerCase());

/**
 * @param {Array} messages  summaries ({id, account, messageId, inReplyTo, references, subject, date, from, to, seen, flagged, hasAttachments, answered})
 * @param {{mine?: Set<string>, bridges?: Array}} opts  the user's own addresses (shown as "Me");
 *   bridges: messages from other folders (cached Sent mail) that only link conversations
 *   together and are never shown or counted. Some senders' References list only the
 *   message they answer, which is the user's reply in Sent, so without it the chain breaks.
 * @returns {Array} threads, newest first: { key, account, members (newest first), latest, count,
 *   subject, participants, unread, flagged, hasAttachments, answered, date }
 */
export function buildThreads(messages, opts = {}) {
  const mine = opts.mine || new Set();
  const parent = new Map();
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n; } // path compression
    return r;
  };
  const add = (x) => { if (!parent.has(x)) parent.set(x, x); };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };

  // Node for a message itself: its Message-ID (per account and subject), or its app id if
  // it has none. Header links only join messages about the same (normalized) subject, like
  // Gmail: notification systems (Jira, GitHub…) point every mail about an item at one
  // anchor id, and those mails shouldn't all become one conversation.
  const scope = (m) => `${m.account}|${normSubject(m.subject)}`;
  const self = (m) => (strip(m.messageId) ? `${scope(m)}|${strip(m.messageId)}` : `${m.account}|#${m.id}`);
  const link = (m) => {
    const me = self(m);
    add(me);
    const linked = [m.inReplyTo, ...(m.references || [])].map(strip).filter(Boolean);
    for (const id of linked) {
      const n = `${scope(m)}|${id}`;
      add(n);
      union(me, n);
    }
  };
  for (const m of messages) link(m);
  for (const m of opts.bridges || []) if (strip(m.messageId)) link(m);

  // Subject fallback for replies whose client dropped the threading headers: join a
  // conversation with the same normalized subject that shares a participant and is
  // within 30 days. Never for plain (non-"Re:") subjects, so "Hello" mails stay apart.
  const bySubject = new Map();
  for (const m of messages) {
    const k = `${m.account}|${normSubject(m.subject)}`;
    if (!normSubject(m.subject)) continue;
    if (!bySubject.has(k)) bySubject.set(k, []);
    bySubject.get(k).push(m);
  }
  for (const m of messages) {
    const headerless = !strip(m.inReplyTo) && !(m.references || []).some((r) => strip(r));
    if (!headerless || !isReplySubject(m.subject)) continue;
    const peers = bySubject.get(`${m.account}|${normSubject(m.subject)}`) || [];
    // A shared participant other than the user (who is on every message).
    const mineEmails = new Set(emailsOf(m).filter((e) => !mine.has(e)));
    for (const p of peers) {
      if (p === m || Math.abs((p.date || 0) - (m.date || 0)) > 30 * DAY) continue;
      if (emailsOf(p).some((e) => mineEmails.has(e))) { union(self(p), self(m)); break; }
    }
  }

  // Collect.
  const groups = new Map();
  for (const m of messages) {
    const r = find(self(m));
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(m);
  }
  const threads = [];
  for (const members of groups.values()) {
    members.sort((a, b) => (b.date || 0) - (a.date || 0) || (b.uid || 0) - (a.uid || 0));
    const oldest = members[members.length - 1];
    // Stable key: the conversation's root id (oldest message's first reference, else its own id).
    const root = strip((oldest.references || [])[0]) || strip(oldest.messageId) || `#${oldest.id}`;
    const seen = new Set();
    const participants = [];
    const participantEmails = [];
    for (const m of [...members].reverse()) {
      const e = (m.from?.email || "").toLowerCase();
      if (!e || seen.has(e)) continue;
      seen.add(e);
      participants.push(mine.has(e) ? "Me" : (m.from.name || m.from.email).trim());
      participantEmails.push(e);
    }
    const latest = members[0];
    threads.push({
      key: `${latest.account}|${root}`,
      account: latest.account,
      members,
      latest,
      count: members.length,
      subject: latest.subject,
      participants,
      participantEmails,
      unread: members.filter((m) => !m.seen).length,
      flagged: members.some((m) => m.flagged),
      hasAttachments: members.some((m) => m.hasAttachments),
      answered: members.some((m) => m.answered),
      date: latest.date,
    });
  }
  // Different-subject conversations can share a root id: keep keys unique.
  const keys = new Map();
  for (const t of threads) keys.set(t.key, (keys.get(t.key) || 0) + 1);
  for (const t of threads) if (keys.get(t.key) > 1) t.key += `|${normSubject(t.subject)}`;
  // Newest conversation first, or oldest first when the list is sorted that way.
  threads.sort((a, b) => (opts.oldest ? -1 : 1) * ((b.date || 0) - (a.date || 0)));
  return threads;
}

/** Ids to search the server with for the rest of a conversation (root first, newest ids next). */
export function threadSeedIds(members) {
  const out = [];
  const push = (id) => { id = strip(id); if (id && !out.includes(id)) out.push(id); };
  const oldest = members[members.length - 1];
  push((oldest?.references || [])[0]);
  for (const m of members) { push(m.messageId); push(m.inReplyTo); }
  for (const m of members) for (const r of m.references || []) push(r);
  return out.slice(0, 8);
}
