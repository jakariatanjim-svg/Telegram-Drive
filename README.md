<div align="center">

<img src="Docs/assets/logo.svg" alt="Telegram Drive logo" width="88">

# Telegram Drive

### Private, portable personal cloud storage powered directly by your own Telegram account

[![Latest Release](https://img.shields.io/github/v/release/jakariatanjim-svg/Telegram-Drive?display_name=tag)](https://github.com/jakariatanjim-svg/Telegram-Drive/releases/latest)
[![Platforms](https://img.shields.io/badge/Platforms-Windows%20%7C%20Android-0ea5e9)](https://github.com/jakariatanjim-svg/Telegram-Drive/releases/latest)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](#license)

[**Download Latest Release**](https://github.com/jakariatanjim-svg/Telegram-Drive/releases/latest) · [**Report an Issue**](https://github.com/jakariatanjim-svg/Telegram-Drive/issues)

</div>

---

**Telegram Drive** turns your own Telegram **Saved Messages** and private channels into a clean, fast, modern cloud drive for **Windows** and **Android**.

This repository provides a **streamlined, enhanced personal edition** forked from the original [Telegram-Drive](https://github.com/caamer20/Telegram-Drive) project — rebuilt to be **100% free forever with zero ads, zero paywalls, zero subscriptions, and zero telemetry**, ready to download and use right away. Your login session, settings, and files stay strictly between your device and Telegram's official servers, with no middleman server in between.

![Telegram Drive Desktop Dashboard](Docs/assets/dashboard.webp)

---

## Key Features

- **Direct Telegram Cloud Workspace** — Manage files in **Saved Messages** or organize them into dedicated private Telegram channels presented as clean cloud folders and color-coded groups.
- **Zero-Knowledge Encryption Vault** — Optionally encrypt sensitive files on your device before upload using authenticated **XChaCha20-Poly1305** encryption (Vault mode or per-file passphrase mode), complete with offline Recovery Kit export and auto-lock protection.
- **Built-in Media Streaming & Previews** — Stream video and audio with instant seeking, view high-resolution images and PDFs, and inspect or extract `.zip` archives directly inside the app.
- **Reliable Queue & Background Transfers** — Pause, resume, retry, or cancel uploads and downloads, drag and drop files or entire folders on Windows, or share files straight from any Android app.
- **Desktop Power Tools (Windows)** — Optional local **Folder Sync**, loopback-only **WebDAV** drive mounting, loopback **REST API**, password-protected local share links, and quiet system-tray background operation.
- **Mobile Privacy Controls (Android)** — Fingerprint / PIN biometric app lock, screenshot & app-switcher privacy (`FLAG_SECURE`), Wi-Fi-only / battery-aware transfer rules, and background transfer notifications.
- **24 Languages & Custom Themes** — Full interface support across 24 languages (including Bengali, English, Arabic, Hindi, Spanish, Russian, Japanese, and more) with light, dark, and custom themes.
- **100% Portable on Windows** — Every setting, login session, encrypted vault, and cache file stays neatly inside the app's own `data/` folder.

---

## Supported Platforms

| Platform | Package Format | System Requirement |
| :--- | :--- | :--- |
| **Windows** | `Telegram-Drive-<X.Y>-portable-setup.exe` | Windows 10 or Windows 11 (64-bit) |
| **Android** | `Telegram-Drive-<X.Y>.apk` | Android 7.0 (Nougat) or newer |

---

## Download & Installation

Always download the latest official files from the [**GitHub Releases**](https://github.com/jakariatanjim-svg/Telegram-Drive/releases/latest) page.

### Windows (Portable Setup)

1. Open [**Releases**](https://github.com/jakariatanjim-svg/Telegram-Drive/releases/latest) and download **`Telegram-Drive-<X.Y>-portable-setup.exe`**.
2. Run the installer.
   - **Windows SmartScreen note:** Because this personal edition is distributed without a paid Microsoft code-signing certificate, Windows may show a *"Windows protected your PC"* prompt on first run. Click **More info** → **Run anyway** to proceed.
3. Choose **any destination folder** you like (for example `D:\Telegram Drive` or `C:\Users\<You>\Programs\Telegram Drive`) and finish setup.
4. Launch **Telegram Drive** from the Start Menu or Desktop shortcut.

### Android (APK)

1. Open [**Releases**](https://github.com/jakariatanjim-svg/Telegram-Drive/releases/latest) on your phone and download **`Telegram-Drive-<X.Y>.apk`**.
2. Tap the downloaded `.apk` file.
   - **Unknown apps prompt:** If Android asks for permission, allow **Install unknown apps** for your browser or file manager, then tap **Install**.
3. If Google Play Protect shows an *"Unrecognized app developer"* prompt on first install, tap **More details** → **Install anyway**.
4. Future updates are signed with the same release key and install cleanly on top of your existing app without losing your login or settings.

---

## Quick Getting-Started Guide

Because Telegram Drive connects **directly** to Telegram without any third-party backend, you sign in once using your own personal Telegram API credentials:

1. Visit [**my.telegram.org**](https://my.telegram.org) in your browser and sign in with your phone number.
2. Open **API development tools**, fill in any app title/short name (for example `MyDrive`), and copy your **`api_id`** and **`api_hash`**.
3. Open **Telegram Drive**, enter your **API ID** and **API Hash**, and sign in either by **scanning the QR code** from Telegram on your phone or by entering your phone number and Telegram login code (plus your 2FA cloud password if enabled).
4. Start uploading, organizing folders, and streaming your files right away!

> **Security tip:** Never share your `api_hash`, login codes, recovery keys, or session files with anyone.

---

## Screenshots

| Windows Folders & Workspace | Windows Media Player |
| :---: | :---: |
| ![Desktop Folders](Docs/assets/folders.webp) | ![Desktop Video Player](Docs/assets/video.webp) |

| Android Cloud Folders | Android Transfer Queue |
| :---: | :---: |
| ![Android Folders](Docs/assets/android-folders.webp) | ![Android Transfers](Docs/assets/android-transfers.webp) |

---

## Where Your Data Is Stored & Privacy

- **Windows Portable `data/` Folder:** All app data — your encrypted Telegram session, vault configuration, preferences, thumbnails, and offline cache — is stored **exclusively inside `<Install Folder>\data\`**. Nothing is ever written to `%APPDATA%` or `%LOCALAPPDATA%`.
  - When uninstalling on Windows, the uninstaller will ask whether you want to **keep** or **permanently delete** your `data/` folder.
- **Android Private Storage:** Your API secret is protected by the **Android Hardware Keystore**, and all session and cache files stay inside Android's private app sandbox (downloaded files are saved to `Downloads/Telegram Drive`).
- **Zero External Servers:** Telegram Drive has **no analytics, no ads, no tracking, and no intermediate relay servers**. Every byte travels directly between your device and Telegram.

---

## How Updates Work

- **Automatic Check:** When you open Telegram Drive, it quietly checks GitHub Releases in the background (with a built-in cooldown so it never slows down startup) and displays an update banner whenever a newer version is available.
- **Manual Check:** Anytime you want to check manually, open **Settings → About** and tap **Check Now**.
- **One-Click Upgrade:**
  - On **Windows**, clicking **Update** downloads the new portable setup and upgrades your existing installation folder silently in place — **without UAC prompts and without touching your `data/` folder** — then restarts the app automatically.
  - On **Android**, tapping **Update** downloads the new signed `.apk` and opens the system installer directly so you can confirm the upgrade in one tap.

---

## Credits & Disclaimer

- **Upstream Credit:** Forked and enhanced from the open-source [Telegram-Drive](https://github.com/caamer20/Telegram-Drive) project, adapted into a clean, portable, completely free Windows & Android edition.
- **Disclaimer:** Telegram Drive is an independent client application and is not affiliated with or endorsed by Telegram FZ-LLC. Please use it responsibly in accordance with Telegram's Terms of Service and keep independent backups of critical files.

## License

Released under the **GNU General Public License v3.0 (GPL-3.0)**.
