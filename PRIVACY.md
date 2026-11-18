# Privacy Policy

**Effective date:** November 18, 2026

Pear Mail is a desktop email client that runs entirely on your Windows computer. This policy explains what information the app handles, where it goes, and the choices you have.

**In short:** Pear Mail has no servers of its own. The developer does not collect, receive, store, sell or share your email, contacts, passwords or any other personal information. The app connects only to your email provider and to the services described below, and only to do the things you ask it to do.

## 1. Who we are

Pear Mail is an independent open-source project published at [github.com/romanmgelman/pearmail](https://github.com/romanmgelman/pearmail). In this policy, "we" and "the developer" mean the maintainer of that project, and "you" means the person using the app.

## 2. Information we collect

**None.** Pear Mail contains no analytics, telemetry, advertising, crash reporting or tracking of any kind. The app never sends information about you or your use of the app to the developer.

## 3. Information stored on your computer

To work, Pear Mail keeps the following data **locally on your computer only**:

| Data | Where it is stored | Purpose |
|---|---|---|
| Passwords, app-specific passwords and sign-in (OAuth) tokens | Windows Credential Manager, in entries named "Pear Mail" | Signing in to your mail accounts |
| Account settings (email address, display name, server names and ports) | `%APPDATA%\PearMail\accounts.json` | Remembering your accounts |
| Cached mail (message headers, previews, and recently viewed or prefetched message bodies) | `%APPDATA%\PearMail\cache-<account>.sqlite` | Fast startup and offline reading |
| Contact photos (iCloud accounts) | `%APPDATA%\PearMail\contact-photos-<account>.json` | Showing sender pictures |
| App preferences (theme, layout, signature, trusted senders for images, and similar) | The app's local WebView storage | Remembering your settings |
| Diagnostic log | `%APPDATA%\PearMail\logs\pearmail.log` (max ~2 MB) | Troubleshooting |

The diagnostic log records connection and sync events and error messages only. It is designed never to contain message subjects, message bodies, passwords or tokens, and email addresses that appear in error messages are replaced with `<address>`. The log stays on your computer unless you choose to share it.

## 4. Services the app connects to

Pear Mail connects directly from your computer to the following services. Your data travels between your computer and these services; it never passes through any server operated by the developer.

- **Your email provider's mail servers** (for example iCloud, Gmail, Outlook.com, Yahoo, AOL, Fastmail, Zoho, GMX, or a server you configure) over encrypted IMAP and SMTP connections, to download, organize and send your mail.
- **iCloud Contacts** (`contacts.icloud.com`), for iCloud accounts only, to download contact photos using the same app-specific password.
- **Microsoft and Google sign-in services** (`login.microsoftonline.com`, `accounts.google.com`, `oauth2.googleapis.com`), only if you choose "Sign in with Microsoft" or "Sign in with Google". Sign-in happens in your web browser on Microsoft's or Google's own page, so Pear Mail never sees your password. Pear Mail receives a sign-in token and your email address and name, which it uses only to connect to your mailbox.
- **Mozilla's mail configuration database** (`autoconfig.thunderbird.net`) and the **autoconfiguration server of your email domain** (`autoconfig.<your domain>`), only when you add an account from a provider the app doesn't already know. These requests include your email domain, and the request to your own domain's server includes your email address, so the correct server settings can be found.
- **GitHub** (`api.github.com` and GitHub's download servers), to check once a day whether a newer version of Pear Mail has been published and, if so, to download it. The request carries only the app's name and version (`PearMail/<version>`); like any web request, GitHub can see your IP address. Updates are installed only if they carry the developer's digital signature. You can turn this off in **Settings → Updates**.
- **Remote content inside emails.** Many emails contain images or other content hosted on the sender's servers. When Pear Mail loads that content, the sender's server can see your IP address and that the message was opened. By default, pictures from the web load automatically; you can change this in **Settings** to load them only from trusted senders.
- **Links you click** open in your default web browser and are governed by that website's own practices.

Each of these services handles your data under its own privacy policy. We encourage you to review the policies of your email provider and any other service you use.

## 5. How the data is used

Data handled by Pear Mail is used only to provide the app's features: showing, searching, organizing, composing and sending your email, showing contact photos and notifications, and remembering your settings. It is not used for advertising, profiling or any other purpose.

## 6. Sharing

The developer does not receive your data, so there is nothing for us to share or sell. If you choose to send a diagnostic log or screenshots when reporting a problem (for example in a public GitHub issue), the information you include becomes visible to whomever can see that report. Please review it first.

## 7. Security

- Mail connections use TLS encryption (IMAP over TLS and SMTP with STARTTLS or TLS).
- Passwords and tokens are kept in Windows Credential Manager, which is protected by your Windows account, and are never written to the app's own files.
- Email content is displayed in a sandboxed frame with scripts disabled.

Cached mail in `%APPDATA%\PearMail` is protected by your Windows user account but is not separately encrypted. Anyone with access to your Windows account can read it. No software is perfectly secure, and we can't guarantee the security of your device or your email provider.

## 8. Your choices and control

- **Remove an account:** Removing an account in Pear Mail deletes its stored password or tokens and its cached mail from your computer. It does not delete anything from your email provider's servers.
- **Delete everything:** Uninstall or delete the app, then delete the `%APPDATA%\PearMail` folder and any "Pear Mail" entries in Windows Credential Manager.
- **Revoke access:** You can revoke app passwords or OAuth access at any time from your Apple, Google, Microsoft or other provider account settings.
- **Remote images:** Choose "Trusted senders only" in Settings to stop images from loading automatically.

Because the developer holds none of your personal data, requests to access, correct or delete it can be handled entirely on your own device as described above.

## 9. Children

Pear Mail is not directed to children under 13 (or the minimum age required in your country) and the developer does not knowingly collect information from anyone.

## 10. Changes to this policy

If this policy changes, the updated version will be published in this repository with a new effective date. Significant changes will also be noted in the release notes. The full history of changes is available in the repository's commit history.

## 11. Contact

Questions about this policy can be raised by opening an issue at [github.com/romanmgelman/pearmail/issues](https://github.com/romanmgelman/pearmail/issues).
