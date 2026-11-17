use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub id: String,
    pub email: String,
    pub name: String,
    /// Name shown to people you email ("" = not known: the address alone).
    pub sender_name: String,
    pub provider: String,
    /// "password" | "microsoft" | "google"
    pub auth: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    #[serde(default)]
    pub account: String,
    /// Raw IMAP path (used for all server operations).
    pub path: String,
    /// Human readable (decoded) display name of the last path segment.
    pub name: String,
    /// inbox | drafts | sent | junk | trash | archive | None for user folders.
    pub role: Option<String>,
    pub depth: usize,
    pub unread: u32,
    pub total: u32,
    pub selectable: bool,
    /// Made by the mail provider (Inbox, Sent, iCloud's Outbox…): can't be renamed or deleted.
    #[serde(default)]
    pub system: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSummary {
    pub uid: u32,
    pub folder: String,
    /// Account id (set when returned to the UI).
    #[serde(default)]
    pub account: String,
    /// Unique across accounts: "<account>:<folder>:<uid>".
    #[serde(default)]
    pub id: String,
    pub from: Person,
    pub to: Vec<Person>,
    pub subject: String,
    pub preview: String,
    /// Unix epoch milliseconds.
    pub date: i64,
    pub seen: bool,
    pub flagged: bool,
    pub answered: bool,
    pub has_attachments: bool,
    #[serde(default)]
    pub attachment_names: Vec<String>,
    #[serde(default)]
    pub size: u32,
    /// Threading headers (bare ids, no angle brackets).
    #[serde(default)]
    pub message_id: String,
    #[serde(default)]
    pub in_reply_to: String,
    #[serde(default)]
    pub references: Vec<String>,
    /// 1 once the threading headers above have been extracted (0 = old cache row).
    #[serde(default)]
    pub thread_v: u8,
    /// Version of the preview builder that made `preview` (5 = current; older rows are refetched).
    #[serde(default)]
    pub preview_v: u8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePage {
    pub messages: Vec<MessageSummary>,
    /// Total number of matching messages in the folder.
    pub total: usize,
    /// Whether more (older) messages exist after this page.
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInfo {
    pub index: usize,
    pub name: String,
    pub mime: String,
    pub size: usize,
    /// How the app can preview it: image, pdf, text, html, audio, video or none.
    pub kind: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDetail {
    pub uid: u32,
    pub folder: String,
    pub account: String,
    pub from: Person,
    pub reply_to: Vec<Person>,
    pub to: Vec<Person>,
    pub cc: Vec<Person>,
    /// Only drafts carry a Bcc header.
    pub bcc: Vec<Person>,
    pub subject: String,
    pub date: i64,
    /// The message this one replies to (bare id), so a resumed draft still threads.
    pub in_reply_to: Option<String>,
    /// Sanitized HTML (always present: plain text is converted to HTML).
    pub html: String,
    pub text: String,
    pub has_remote_content: bool,
    pub attachments: Vec<AttachmentInfo>,
    /// Pictures embedded in the body (not in `attachments`), openable in the viewer.
    pub inline_images: Vec<AttachmentInfo>,
    pub message_id: Option<String>,
    pub references: Vec<String>,
    pub seen: bool,
    pub flagged: bool,
    pub raw_headers: String,
    /// True when only the start of a large message was downloaded (attachments pending).
    pub partial: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingAttachment {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingMessage {
    pub to: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
    #[serde(default)]
    pub bcc: Vec<String>,
    pub subject: String,
    pub html: String,
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<OutgoingAttachment>,
    pub in_reply_to: Option<String>,
    #[serde(default)]
    pub references: Vec<String>,
    /// UID of a previously saved draft to replace / remove.
    pub draft_uid: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFile {
    pub name: String,
    pub path: String,
    pub size: u64,
}
