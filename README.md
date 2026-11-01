<div align="center">

# Telegram Drive

**Private, high-speed personal cloud storage for Windows & Android — powered directly by your own Telegram account**

[![Latest Release](https://img.shields.io/github/v/release/jakariatanjim-svg/Telegram-Drive?display_name=tag&style=for-the-badge&label=Latest%20Release&color=0284c7)](https://github.com/jakariatanjim-svg/Telegram-Drive/releases/latest)
[![Windows](https://img.shields.io/badge/Windows-10%20%2F%2011%20(64--bit)-0078D4?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/jakariatanjim-svg/Telegram-Drive/releases/latest)
[![Android](https://img.shields.io/badge/Android-7.0%2B%20APK-3DDC84?style=for-the-badge&logo=android&logoColor=white)](https://github.com/jakariatanjim-svg/Telegram-Drive/releases/latest)

[![100% Free](https://img.shields.io/badge/100%25%20Free-No%20Ads%20%C2%B7%20No%20Paywalls-10b981?style=flat-square)](#privacy--security)
[![Architecture](https://img.shields.io/badge/Connection-Direct%20Telegram%20MTProto-6366f1?style=flat-square)](#privacy--security)
[![Portable](https://img.shields.io/badge/Windows%20Storage-100%25%20Portable%20data%2F-f59e0b?style=flat-square)](#where-your-data-lives)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-3b82f6?style=flat-square)](#license)

<br />

[**⬇ Download Latest Release**](https://github.com/jakariatanjim-svg/Telegram-Drive/releases/latest) &nbsp;·&nbsp; [**Quick Setup**](#getting-started) &nbsp;·&nbsp; [**Link PC & Phone**](#link-your-second-device-in-one-step) &nbsp;·&nbsp; [**Report an Issue**](https://github.com/jakariatanjim-svg/Telegram-Drive/issues)

</div>

---

## Overview

**Telegram Drive** turns your own Telegram **Saved Messages** and private Telegram channels into a fast, organized personal cloud drive on **Windows PC** and **Android**.

- **100% Free Forever** — Zero ads, zero subscriptions, zero paywalls, and zero tracking.
- **No Middleman Server** — Connects directly from your device to Telegram's official servers using your own personal credentials.
- **Built for Heavy Real-World Use** — Upload, stream, and download files of **any size** (including 40 GB+ games, `.iso` images, `.zip` / `.rar` archives, movies, and backups) without hitting Telegram's single-file limit.

---

## Key Features

### Cloud Storage & Transfers
- **Unlimited File Size Support** — Files larger than Telegram's single-message limit are automatically split during upload and reassembled byte-for-byte into the exact original file on download, supporting every file format (`.exe`, `.iso`, `.zip`, `.rar`, game backups, 4K videos, and more).
- **Auto-Resume & Power-Cut Protection** — Interrupted uploads and downloads automatically continue from completed parts, while checksum-verified local state backups protect your session and transfer queue against sudden power cuts or network drops.
- **Clean Cloud Folders & Groups** — Store files in **Saved Messages** or organize them into dedicated private Telegram channels presented as cloud folders and color-coded groups.

### Instant Cross-Device Sign-In
- **One-Step PC ↔ Android Linking** — Set up once on either your PC or your Android phone, then sign in on your other device in seconds by **scanning a QR code** or **entering a Link Code** — no need to re-enter API keys or OTP codes.

### Media, Preview & Streaming
- **Direct Video & Music Streaming** — Stream videos and audio tracks (including multi-part large media) immediately with instant seeking, quality selection, and built-in media controls — without waiting for the full file to download.
- **Smart Portable Media Engine (Windows)** — Automatically detects FFmpeg or lets you install a portable copy straight into the app's `data/` folder with one click when needed for advanced audio/video formats.
- **Built-in Previews** — View high-resolution photos, read PDFs, and inspect or extract `.zip` files right inside the app.

### Security, Portability & Platform Tools
- **Zero-Knowledge Encryption Vault** — Optionally encrypt sensitive files on your device before upload using authenticated **XChaCha20-Poly1305** encryption, complete with an offline Recovery Kit and automatic vault lock.
- **True Windows Portability** — Everything stays strictly inside `<Install Folder>\data\`, with a built-in **Move / Relocate App Folder** tool to move your installation to another drive anytime.
- **Desktop Power Tools (Windows)** — Local two-way/one-way **Folder Sync**, local **WebDAV** network drive mounting, local **REST API**, password-protected local share links, and quiet system-tray operation.
- **Smart Android Controls** — Automatic memory tuning for low-RAM phones, **Data Saver** mode on mobile data, fingerprint / PIN app lock, screenshot privacy protection, and direct file sharing from any Android app.
- **24 Languages & Themes** — Full interface support across 24 languages with light, dark, and custom color themes.

---

## Download & Installation

Always download the latest official packages from the [**Latest Release**](https://github.com/jakariatanjim-svg/Telegram-Drive/releases/latest) page.

### Windows PC (`Portable Setup`)

1. Go to [**Releases**](https://github.com/jakariatanjim-svg/Telegram-Drive/releases/latest) and download the Windows installer (`*-portable-setup.exe`).
2. Open the downloaded `.exe` file.
   > **Windows SmartScreen tip:** Because this personal edition does not use a paid Microsoft certificate, Windows may show a *"Windows protected your PC"* screen the first time. Click **More info** → **Run anyway**.
3. Pick **any drive or folder** you want (for example `D:\Telegram Drive`) and complete installation.
4. Launch **Telegram Drive** from your Desktop or Start Menu shortcut.

### Android Phone (`APK`)

1. Open [**Releases**](https://github.com/jakariatanjim-svg/Telegram-Drive/releases/latest) on your phone and download the Android package (`*.apk`).
2. Tap the downloaded `.apk` file to install.
   > **First-time install tip:** If prompted, allow **Install unknown apps** for your browser or file manager. If Google Play Protect shows an *"Unrecognized app developer"* prompt, tap **More details** → **Install anyway**.
3. Open **Telegram Drive** — future updates install cleanly right over your existing app without losing your login or settings.

---

## Getting Started

### First Device Setup (One Time Only)

1. Open [**my.telegram.org**](https://my.telegram.org) in any browser and sign in with your Telegram phone number.
2. Tap **API development tools**, enter any app title and short name (for example `MyDrive`), and copy your **`api_id`** and **`api_hash`**.
3. Open **Telegram Drive**, enter your **API ID** and **API Hash**, and sign in via **QR scan** or **phone number + login code** (plus your 2FA password if enabled on your Telegram account).

### Link Your Second Device in One Step

Already signed in on your PC or phone? You don't need to repeat the setup on your other device:

1. On your **already signed-in device**, open **Settings → Link Another Device** to display a **QR Code** and **Link Code**.
2. On your **new device** (right on the first login screen), tap **Scan QR** (using your phone camera or PC webcam) or **Enter Code**, and you're signed in immediately.

> [!IMPORTANT]
> Never share your `api_hash`, Link Codes, recovery keys, or `data/` folder with anyone else — they grant direct access to your Telegram Drive.

---

## System Requirements

| Platform | Minimum Requirement | Recommended |
| :--- | :--- | :--- |
| **Windows** | Windows 10 (64-bit), 4 GB RAM | Windows 10 / 11 (64-bit), 8 GB+ RAM |
| **Android** | Android 7.0 (Nougat) or newer | Android 9.0+, 4 GB+ RAM (1–3 GB RAM phones are supported automatically in low-memory mode) |

---

## Where Your Data Lives

| Platform | Storage Location & Behavior |
| :--- | :--- |
| **Windows** | **100% inside `<Install Folder>\data\`** — your encrypted login session, settings, state backups (`data\backups`), temporary transfer files (`data\temp`), optional portable FFmpeg (`data\bin`), and caches stay inside this single folder. Nothing is stored in `AppData` or system `Temp`. On uninstall, you choose whether to keep or delete `data\`. |
| **Android** | Protected inside Android's private app storage with secrets encrypted by the **Android Hardware Keystore**. Downloaded files are saved to `Downloads/Telegram Drive`. |

---

## In-App Updates

- **Automatic Check on Launch** — Telegram Drive quietly checks for new releases when opened and displays a non-intrusive update banner when a newer version is ready.
- **Manual Check** — Open **Settings → About** anytime and tap **Check Now**.
- **Seamless Upgrade** — On Windows, updates install directly into your current folder without touching `data\`. On Android, the app downloads the new signed `.apk` and hands off to the Android package installer in one tap.

---

## Privacy & Security

- **Direct-to-Telegram Only** — Zero analytics, zero telemetry, zero ads, and zero third-party relay servers.
- **Local Credential Protection** — API secrets and login sessions are encrypted at rest on your device.
- **Optional End-to-End File Encryption** — Enable the built-in Encryption Vault whenever you want files encrypted locally with **XChaCha20-Poly1305** before they are uploaded to Telegram.

---

## Credits & Disclaimer

- Adapted and enhanced from the open-source [Telegram-Drive](https://github.com/caamer20/Telegram-Drive) project into a streamlined, ad-free, portable Windows & Android edition.
- **Disclaimer:** Telegram Drive is an independent client and is not affiliated with or endorsed by Telegram FZ-LLC. Always use it in compliance with Telegram's Terms of Service and maintain separate backups of critical files.

## License

Released under the **GNU General Public License v3.0 (GPL-3.0)**.
