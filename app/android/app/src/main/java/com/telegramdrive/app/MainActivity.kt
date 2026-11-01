package com.telegramdrive.app

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import com.getcapacitor.BridgeActivity
import java.io.File
import java.io.FileOutputStream

class MainActivity : BridgeActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(TelegramDrivePlugin::class.java)
        super.onCreate(savedInstanceState)
        if (intent?.action == Intent.ACTION_VIEW) {
            window?.decorView?.post { handleIncomingIntent(intent) }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingIntent(intent)
    }

    private fun extractParcelableUri(intent: Intent): Uri? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(Intent.EXTRA_STREAM)
        }
    }

    private fun extractParcelableUriList(intent: Intent): List<Uri> {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java) ?: emptyList()
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM) ?: emptyList()
        }
    }

    private fun handleIncomingIntent(intent: Intent?) {
        if (intent == null) return
        when (intent.action) {
            Intent.ACTION_VIEW -> {
                val url = intent.dataString ?: return
                if (url.startsWith("tgdrive://", ignoreCase = true)) {
                    val handle = bridge?.getPlugin("TelegramDriveNative")
                    (handle?.instance as? TelegramDrivePlugin)?.emitDeepLink(url)
                }
            }
            Intent.ACTION_SEND -> {
                extractParcelableUri(intent)?.let { stageSharedUri(it) }
            }
            Intent.ACTION_SEND_MULTIPLE -> {
                for (uri in extractParcelableUriList(intent)) {
                    stageSharedUri(uri)
                }
            }
        }
    }

    private fun stageSharedUri(uri: Uri) {
        Thread {
            try {
                var displayName = "shared_${System.currentTimeMillis()}"
                contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                    val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (idx >= 0 && cursor.moveToFirst()) {
                        displayName = cursor.getString(idx) ?: displayName
                    }
                }
                val sharedDir = File(cacheDir, "shared_incoming").apply { mkdirs() }
                val dest = File(sharedDir, "${System.currentTimeMillis()}_${displayName}")
                contentResolver.openInputStream(uri)?.use { input ->
                    FileOutputStream(dest).use { output -> input.copyTo(output) }
                }
                synchronized(TelegramDrivePlugin.sharedCachedFiles) {
                    TelegramDrivePlugin.sharedCachedFiles.add(
                        TelegramDrivePlugin.SharedCachedEntry(
                            uri = uri.toString(),
                            fileName = displayName,
                            fileSize = dest.length(),
                            cachedPath = dest.absolutePath
                        )
                    )
                }
            } catch (_: Exception) {
                // Ignore transient URI read error
            }
        }.start()
    }
}
