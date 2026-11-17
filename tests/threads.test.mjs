// Run: node tests/threads.test.mjs
import { buildThreads, normSubject, threadSeedIds } from "../ui/js/threads.js";

const D = 86400000, t0 = Date.UTC(2026, 10, 1);
let n = 0;
const msg = (o) => ({ id: `a1:INBOX:${++n}`, uid: n, account: "a1", messageId: "", inReplyTo: "", references: [], subject: "Hi", date: t0 + n * 1000, from: { name: "X", email: "x@x.com" }, to: [], seen: true, ...o });
let fail = 0;
const eq = (label, got, want) => { const g = JSON.stringify(got), w = JSON.stringify(want); if (g !== w) { fail++; console.log(`FAIL ${label}: got ${g}, want ${w}`); } };

// 1. References chain.
{
  const a = msg({ messageId: "a@x", subject: "Plan", from: { name: "Ann", email: "ann@x.com" } });
  const b = msg({ messageId: "b@x", inReplyTo: "a@x", references: ["a@x"], subject: "Re: Plan", from: { name: "Bob", email: "bob@x.com" } });
  const c = msg({ messageId: "c@x", inReplyTo: "b@x", references: ["a@x", "b@x"], subject: "Re: Plan", from: { name: "Ann", email: "ann@x.com" } });
  const t = buildThreads([a, b, c]);
  eq("chain: one thread", t.length, 1);
  eq("chain: newest first", t[0].members.map((m) => m.messageId), ["c@x", "b@x", "a@x"]);
  eq("chain: participants oldest first, unique", t[0].participants, ["Ann", "Bob"]);
  eq("chain: key is root", t[0].key, "a1|a@x");
}
// 2. Missing intermediate (my reply lives in Sent): still one conversation via References.
{
  const a = msg({ messageId: "r1@x" });
  const c = msg({ messageId: "r3@x", inReplyTo: "r2@x", references: ["r1@x", "r2@x"] });
  eq("missing middle", buildThreads([a, c]).length, 1);
}
// 3. In-Reply-To only.
{
  const a = msg({ messageId: "i1@x" });
  const b = msg({ messageId: "i2@x", inReplyTo: "<i1@x>" });
  eq("in-reply-to only", buildThreads([a, b]).length, 1);
}
// 4. Subject fallback: Re: + shared participant + within 30 days → merge.
{
  const a = msg({ messageId: "s1@x", subject: "Budget", from: { name: "Ann", email: "ann@x.com" }, to: [{ name: "Me", email: "me@icloud.com" }] });
  const b = msg({ messageId: "s2@x", subject: "RE: Budget", from: { name: "Me", email: "me@icloud.com" }, to: [{ name: "Ann", email: "ann@x.com" }] });
  const t = buildThreads([a, b], { mine: new Set(["me@icloud.com"]) });
  eq("subject fallback merges", t.length, 1);
  eq("Me participant", t[0].participants, ["Ann", "Me"]);
}
// 5. Subject fallback refuses: no shared participant / too old / not a reply.
{
  const a = msg({ messageId: "h1@x", subject: "Budget", from: { name: "Ann", email: "ann@x.com" } });
  const b = msg({ messageId: "h2@x", subject: "Re: Budget", from: { name: "Zed", email: "zed@y.com" } });
  eq("no shared participant", buildThreads([a, b]).length, 2);
  const c = msg({ messageId: "h3@x", subject: "Re: Budget", from: { name: "Ann", email: "ann@x.com" }, date: t0 + 40 * D });
  eq("too old", buildThreads([a, c]).length, 2);
  const d = msg({ messageId: "h4@x", subject: "Hello" }), e = msg({ messageId: "h5@x", subject: "Hello" });
  eq("plain same subject stays apart", buildThreads([d, e]).length, 2);
}
// 6. Same ids in different accounts stay separate.
{
  const a = msg({ messageId: "x1@x" }), b = msg({ account: "a2", id: "a2:INBOX:1", messageId: "x2@x", inReplyTo: "x1@x" });
  eq("accounts separate", buildThreads([a, b]).length, 2);
}
{
  // Sorted oldest first: conversations come in ascending date order.
  const x = { id: "x", account: "a", messageId: "x@1", references: [], subject: "One", from: { email: "p@x" }, to: [], date: 1000 };
  const y = { id: "y", account: "a", messageId: "y@1", references: [], subject: "Two", from: { email: "q@x" }, to: [], date: 2000 };
  eq("newest first", buildThreads([x, y]).map((t) => t.latest.id).join(","), "y,x");
  eq("oldest first", buildThreads([x, y], { oldest: true }).map((t) => t.latest.id).join(","), "x,y");
}
// 7. Messages without any Message-ID don't collapse together.
{
  eq("no ids", buildThreads([msg({}), msg({})]).length, 2);
}
// 8. Thread flags and ordering of threads.
{
  const a = msg({ messageId: "f1@x", seen: false, date: t0 });
  const b = msg({ messageId: "f2@x", inReplyTo: "f1@x", flagged: true, hasAttachments: true, date: t0 + D });
  const lone = msg({ messageId: "f3@x", date: t0 + 2 * D });
  const t = buildThreads([a, b, lone]);
  eq("threads newest first", t.map((x) => x.count), [1, 2]);
  eq("aggregates", [t[1].unread, t[1].flagged, t[1].hasAttachments], [1, true, true]);
}
// 9. Subject normalization and seeds.
eq("normSubject", normSubject("RE: Fwd: AW:  Weekly   Sync"), "weekly sync");
eq("normSubject [2]", normSubject("Re[2]: x"), "x");
eq("seeds root first", threadSeedIds([{ messageId: "c", inReplyTo: "b", references: ["a", "b"] }, { messageId: "b", inReplyTo: "a", references: ["a"] }]), ["a", "c", "b"]);

// Notification anchors: different subjects referencing one missing id stay apart (like Gmail).
{
  const a = msg({ messageId: "j1@x", inReplyTo: "anchor@jira", references: ["anchor@jira"], subject: "[JIRA] Mark assigned AD-60 to you" });
  const b = msg({ messageId: "j2@x", inReplyTo: "anchor@jira", references: ["anchor@jira"], subject: "[JIRA] Mark commented on AD-60" });
  const c = msg({ messageId: "j3@x", inReplyTo: "anchor@jira", references: ["anchor@jira"], subject: "[JIRA] Mark commented on AD-60" });
  const t = buildThreads([a, b, c]);
  eq("anchor: different subjects apart", t.length, 2);
  eq("anchor: unique keys", new Set(t.map((x) => x.key)).size, 2);
  const r1 = msg({ messageId: "p@x", subject: "Lunch" });
  const r2 = msg({ messageId: "q@x", inReplyTo: "p@x", references: ["p@x"], subject: "RE: lunch" });
  eq("reply joins parent across Re:/case", buildThreads([r1, r2]).length, 1);
}
// Bridges: each received message references only the user's reply (in Sent, not listed).
{
  const recv = [], sent = [];
  let prev = "";
  for (let i = 0; i < 5; i++) {
    const r = msg({ messageId: `r${i}@x`, inReplyTo: prev, references: prev ? [prev] : [], subject: "Re: Docs", from: { name: "Asli", email: "info@x.com" } });
    const s = msg({ messageId: `s${i}@me`, inReplyTo: r.messageId, references: [r.messageId], subject: "Re: Docs", from: { name: "Me", email: "me@me.com" } });
    recv.push(r); sent.push(s); prev = s.messageId;
  }
  eq("no bridges: chain broken", buildThreads(recv).length > 1, true);
  const t = buildThreads(recv, { bridges: sent });
  eq("bridges: one thread", t.length, 1);
  eq("bridges: only listed messages counted", t[0].count, 5);
}
console.log(fail ? `${fail} failed` : "all thread tests passed");
process.exit(fail ? 1 : 0);
