package com.telegramdrive.app

import android.Manifest
import android.app.Activity
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.os.StatFs
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.view.WindowManager
import androidx.activity.result.ActivityResult
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.fragment.app.FragmentActivity
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@CapacitorPlugin(name = "TelegramDriveNative")
class TelegramDrivePlugin : Plugin() {

    companion object {
        private const val KEYSTORE_ALIAS = "telegram_drive_keystore_v1"
        private const val PREFS_NAME = "telegram_drive_secure_prefs"
        private val keystoreLock = Any()
        val sharedCachedFiles = mutableListOf<SharedCachedEntry>()
    }

    data class SharedCachedEntry(
        val uri: String,
        val fileName: String,
        val fileSize: Long,
        val cachedPath: String
    )

    private val ioExecutor = Executors.newCachedThreadPool()

    private fun getOrCreateSecretKey(): SecretKey = synchronized(keystoreLock) {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = ks.getEntry(KEYSTORE_ALIAS, null) as? KeyStore.SecretKeyEntry
        if (existing != null) return existing.secretKey

        val keyGenerator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            "AndroidKeyStore"
        )
        val spec = KeyGenParameterSpec.Builder(
            KEYSTORE_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()
        keyGenerator.init(spec)
        return keyGenerator.generateKey()
    }

    @PluginMethod
    fun secureSet(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("Missing key")
        val value = call.getString("value") ?: ""
        val appCtx = context.applicationContext
        ioExecutor.execute {
            try {
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.ENCRYPT_MODE, getOrCreateSecretKey())
                val iv = Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
                val ct = Base64.encodeToString(cipher.doFinal(value.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
                appCtx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .edit()
                    .putString(key, "$iv:$ct")
                    .apply()
                call.resolve()
            } catch (t: Throwable) {
                call.reject("Keystore encrypt failed: ${t.message}")
            }
        }
    }

    @PluginMethod
    fun secureGet(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("Missing key")
        val appCtx = context.applicationContext
        ioExecutor.execute {
            val ret = JSObject()
            try {
                val raw = appCtx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getString(key, null)
                if (raw == null || !raw.contains(":")) {
                    ret.put("value", JSObject.NULL)
                    call.resolve(ret)
                    return@execute
                }
                val parts = raw.split(":", limit = 2)
                val iv = Base64.decode(parts[0], Base64.NO_WRAP)
                val ct = Base64.decode(parts[1], Base64.NO_WRAP)
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, getOrCreateSecretKey(), GCMParameterSpec(128, iv))
                val plain = String(cipher.doFinal(ct), Charsets.UTF_8)
                ret.put("value", plain)
                call.resolve(ret)
            } catch (_: Throwable) {
                ret.put("value", JSObject.NULL)
                call.resolve(ret)
            }
        }
    }

    @PluginMethod
    fun secureRemove(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("Missing key")
        val appCtx = context.applicationContext
        ioExecutor.execute {
            try {
                appCtx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .edit()
                    .remove(key)
                    .apply()
                call.resolve()
            } catch (t: Throwable) {
                call.reject("Keystore remove failed: ${t.message}")
            }
        }
    }

    @PluginMethod
    fun isBiometricAvailable(call: PluginCall) {
        val appCtx = context.applicationContext
        ioExecutor.execute {
            try {
                val authenticators =
                    BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL
                val canAuth = BiometricManager.from(appCtx).canAuthenticate(authenticators)
                call.resolve(JSObject().put("available", canAuth == BiometricManager.BIOMETRIC_SUCCESS))
            } catch (_: Throwable) {
                call.resolve(JSObject().put("available", false))
            }
        }
    }

    @PluginMethod
    fun authenticate(call: PluginCall) {
        val fragActivity = activity as? FragmentActivity
            ?: return call.resolve(JSObject().put("authenticated", false))
        val reason = call.getString("reason") ?: "Authenticate to unlock Telegram Drive"
        fragActivity.runOnUiThread {
            val executor = ContextCompat.getMainExecutor(context)
            val prompt = BiometricPrompt(
                fragActivity,
                executor,
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        call.resolve(JSObject().put("authenticated", true))
                    }

                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        call.resolve(JSObject().put("authenticated", false))
                    }
                }
            )
            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle("Telegram Drive")
                .setSubtitle(reason)
                .setAllowedAuthenticators(
                    BiometricManager.Authenticators.BIOMETRIC_WEAK or
                        BiometricManager.Authenticators.DEVICE_CREDENTIAL
                )
                .build()
            prompt.authenticate(info)
        }
    }

    @PluginMethod
    fun setPrivacyScreen(call: PluginCall) {
        val enabled = call.getBoolean("enabled") ?: false
        val act = activity ?: return call.resolve(JSObject().put("applied", false))
        act.runOnUiThread {
            if (enabled) {
                act.window.setFlags(
                    WindowManager.LayoutParams.FLAG_SECURE,
                    WindowManager.LayoutParams.FLAG_SECURE
                )
            } else {
                act.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
            }
            call.resolve(JSObject().put("applied", true))
        }
    }

    @PluginMethod
    fun getTransferEnvironment(call: PluginCall) {
        val appCtx = context.applicationContext
        ioExecutor.execute {
            try {
                val cm = appCtx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
                val activeNet = cm.activeNetwork
                val caps = activeNet?.let { cm.getNetworkCapabilities(it) }
                val connected = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
                val wifi = caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
                val roaming = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_ROAMING) == false
                val metered = cm.isActiveNetworkMetered

                val batteryIntent = appCtx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
                val level = batteryIntent?.getIntExtra(BatteryManager.EXTRA_LEVEL, 100) ?: 100
                val scale = batteryIntent?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
                val pct = if (scale > 0) (level * 100) / scale else 100
                val status = batteryIntent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
                val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                    status == BatteryManager.BATTERY_STATUS_FULL

                val pm = appCtx.getSystemService(Context.POWER_SERVICE) as PowerManager
                val statFs = StatFs(appCtx.filesDir.absolutePath)
                val availBytes = statFs.availableBytes

                val notifPerm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    if (ContextCompat.checkSelfPermission(appCtx, Manifest.permission.POST_NOTIFICATIONS) ==
                        PackageManager.PERMISSION_GRANTED
                    ) "granted" else "prompt"
                } else {
                    "granted"
                }

                val ret = JSObject().apply {
                    put("connected", connected)
                    put("metered", metered)
                    put("roaming", roaming)
                    put("charging", charging)
                    put("batteryLow", pct <= 15)
                    put("storageLow", availBytes < 256L * 1024L * 1024L)
                    put("freeBytes", availBytes)
                    put("powerSaveMode", pm.isPowerSaveMode)
                    put("backgroundRestricted", false)
                    put("network_connected", connected)
                    put("wifi_connected", wifi)
                    put("battery_percent", pct)
                    put("power_save_mode", pm.isPowerSaveMode)
                    put("available_storage_bytes", availBytes)
                    put("notification_permission", notifPerm)
                    put("recovery_supported", true)
                }
                call.resolve(ret)
            } catch (t: Throwable) {
                call.reject("Transfer environment query failed: ${t.message}")
            }
        }
    }

    @PluginMethod
    fun startForegroundService(call: PluginCall) {
        val intent = Intent(context, UploadForegroundService::class.java).apply {
            action = UploadForegroundService.ACTION_START
            putExtra(UploadForegroundService.EXTRA_TITLE, call.getString("title") ?: "Telegram Drive")
            putExtra(UploadForegroundService.EXTRA_BODY, call.getString("body") ?: "Transferring files")
        }
        ContextCompat.startForegroundService(context, intent)
        call.resolve()
    }

    @PluginMethod
    fun updateForegroundService(call: PluginCall) {
        val intent = Intent(context, UploadForegroundService::class.java).apply {
            action = UploadForegroundService.ACTION_UPDATE
            putExtra(UploadForegroundService.EXTRA_TITLE, call.getString("title") ?: "Telegram Drive")
            putExtra(UploadForegroundService.EXTRA_BODY, call.getString("body") ?: "Transferring files")
            putExtra(UploadForegroundService.EXTRA_PROGRESS, call.getInt("progress") ?: -1)
        }
        context.startService(intent)
        call.resolve()
    }

    @PluginMethod
    fun stopForegroundService(call: PluginCall) {
        val intent = Intent(context, UploadForegroundService::class.java).apply {
            action = UploadForegroundService.ACTION_STOP
        }
        context.stopService(intent)
        call.resolve()
    }

    @PluginMethod
    fun getPendingTransferAction(call: PluginCall) {
        call.resolve(JSObject().put("action", ""))
    }

    @PluginMethod
    fun getPendingShareCount(call: PluginCall) {
        synchronized(sharedCachedFiles) {
            call.resolve(JSObject().put("count", sharedCachedFiles.size))
        }
    }

    @PluginMethod
    fun listSharedCachedFiles(call: PluginCall) {
        val arr = JSArray()
        synchronized(sharedCachedFiles) {
            for (item in sharedCachedFiles) {
                arr.put(
                    JSObject().apply {
                        put("uri", item.uri)
                        put("file_name", item.fileName)
                        put("file_size", item.fileSize)
                        put("cached_path", item.cachedPath)
                    }
                )
            }
        }
        call.resolve(JSObject().put("files", arr))
    }

    @PluginMethod
    fun removeSharedCachedFile(call: PluginCall) {
        val uri = call.getString("uri") ?: ""
        synchronized(sharedCachedFiles) {
            val iter = sharedCachedFiles.iterator()
            while (iter.hasNext()) {
                val cur = iter.next()
                if (cur.uri == uri) {
                    File(cur.cachedPath).delete()
                    iter.remove()
                }
            }
        }
        call.resolve()
    }

    @PluginMethod
    fun pickFiles(call: PluginCall) {
        val multiple = call.getBoolean("multiple") ?: false
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
        }
        startActivityForResult(call, intent, "onFilesPickedResult")
    }

    @ActivityCallback
    private fun onFilesPickedResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val filesArr = JSArray()
        if (result.resultCode != Activity.RESULT_OK || result.data == null) {
            return call.resolve(JSObject().put("files", filesArr))
        }

        ioExecutor.execute {
            try {
                val data = result.data!!
                val uris = mutableListOf<Uri>()
                data.clipData?.let { clip ->
                    for (i in 0 until clip.itemCount) {
                        clip.getItemAt(i).uri?.let { uris.add(it) }
                    }
                }
                if (uris.isEmpty()) {
                    data.data?.let { uris.add(it) }
                }

                val pickedDir = File(context.cacheDir, "picked").apply { mkdirs() }
                for (uri in uris) {
                    var displayName = "file_${System.currentTimeMillis()}"
                    context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                        val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        if (idx >= 0 && cursor.moveToFirst()) {
                            displayName = cursor.getString(idx) ?: displayName
                        }
                    }
                    val safeFile = File(pickedDir, "${System.currentTimeMillis()}_${displayName}")
                    context.contentResolver.openInputStream(uri)?.use { input ->
                        FileOutputStream(safeFile).use { output -> input.copyTo(output) }
                    }
                    filesArr.put(
                        JSObject().apply {
                            put("uri", uri.toString())
                            put("name", displayName)
                            put("size", safeFile.length())
                            put("mimeType", context.contentResolver.getType(uri) ?: "application/octet-stream")
                            put("cachedPath", safeFile.absolutePath)
                        }
                    )
                }
                call.resolve(JSObject().put("files", filesArr))
            } catch (e: Exception) {
                call.reject("Failed to read picked files: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun readFileBase64(call: PluginCall) {
        val filePath = call.getString("path") ?: return call.reject("Missing path")
        ioExecutor.execute {
            try {
                val f = File(filePath)
                val bytes = f.readBytes()
                val ret = JSObject().apply {
                    put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
                    put("name", f.name)
                    put("size", bytes.size)
                }
                call.resolve(ret)
            } catch (e: Exception) {
                call.reject("Failed to read file: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun writeFileBase64(call: PluginCall) {
        val directory = call.getString("directory") ?: "downloads"
        val filename = call.getString("filename") ?: "telegram_file"
        val dataB64 = call.getString("data") ?: return call.reject("Missing data")
        val mimeType = call.getString("mimeType") ?: "application/octet-stream"

        ioExecutor.execute {
            try {
                val bytes = Base64.decode(dataB64, Base64.DEFAULT)
                if (directory == "downloads" && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val values = ContentValues().apply {
                        put(MediaStore.Downloads.DISPLAY_NAME, filename)
                        put(MediaStore.Downloads.MIME_TYPE, mimeType)
                        put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Telegram Drive")
                    }
                    val uri = context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                        ?: throw IllegalStateException("Could not create Downloads entry")
                    context.contentResolver.openOutputStream(uri)?.use { out -> out.write(bytes) }
                    call.resolve(
                        JSObject().apply {
                            put("path", uri.toString())
                            put("uri", uri.toString())
                        }
                    )
                } else {
                    val baseDir = if (directory == "downloads") {
                        Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                    } else {
                        context.cacheDir
                    }
                    val targetDir = File(baseDir, "Telegram Drive").apply { mkdirs() }
                    val outFile = File(targetDir, filename)
                    outFile.writeBytes(bytes)
                    call.resolve(
                        JSObject().apply {
                            put("path", outFile.absolutePath)
                            put("uri", Uri.fromFile(outFile).toString())
                        }
                    )
                }
            } catch (e: Exception) {
                call.reject("Failed to save file: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun openFileExternally(call: PluginCall) {
        val rawPath = call.getString("path") ?: return call.reject("Missing path")
        val mime = call.getString("mimeType") ?: "*/*"
        try {
            val uri = if (rawPath.startsWith("content://")) {
                Uri.parse(rawPath)
            } else {
                FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", File(rawPath))
            }
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, mime)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            call.resolve()
        } catch (e: Exception) {
            call.reject("Unable to open file externally: ${e.message}")
        }
    }

    @PluginMethod
    fun openStreamPlayer(call: PluginCall) {
        val streamUrl = call.getString("streamUrl") ?: return call.reject("Missing streamUrl")
        val mime = call.getString("mimeType") ?: "video/*"
        try {
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(Uri.parse(streamUrl), mime)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            call.resolve()
        } catch (e: Exception) {
            call.reject("No external player available: ${e.message}")
        }
    }

    @PluginMethod
    fun openExternalUrl(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("Missing url")
        try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            call.resolve()
        } catch (e: Exception) {
            call.reject("Cannot open URL: ${e.message}")
        }
    }

    @PluginMethod
    fun downloadAndInstallApk(call: PluginCall) {
        val downloadUrl = call.getString("downloadUrl") ?: return call.reject("Missing downloadUrl")
        val fileName = call.getString("fileName") ?: "Telegram-Drive-update.apk"

        ioExecutor.execute {
            try {
                val updatesDir = File(context.cacheDir, "updates").apply { mkdirs() }
                val apkFile = File(updatesDir, File(fileName).name)

                val conn = (URL(downloadUrl).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 15_000
                    readTimeout = 30_000
                    instanceFollowRedirects = true
                    setRequestProperty("User-Agent", "Telegram-Drive-Android-Updater")
                    connect()
                }
                if (conn.responseCode !in 200..299) {
                    throw IllegalStateException("HTTP ${conn.responseCode}")
                }

                val totalBytes = conn.contentLengthLong
                var downloaded = 0L

                conn.inputStream.use { input ->
                    FileOutputStream(apkFile).use { output ->
                        val buffer = ByteArray(32 * 1024)
                        while (true) {
                            val read = input.read(buffer)
                            if (read <= 0) break
                            output.write(buffer, 0, read)
                            downloaded += read
                            if (totalBytes > 0) {
                                val pct = ((downloaded * 100L) / totalBytes).toInt().coerceIn(0, 99)
                                notifyListeners("apkDownloadProgress", JSObject().put("progress", pct))
                            }
                        }
                    }
                }

                notifyListeners("apkDownloadProgress", JSObject().put("progress", 100))

                val apkUri = FileProvider.getUriForFile(
                    context,
                    "${context.packageName}.fileprovider",
                    apkFile
                )
                val installIntent = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(apkUri, "application/vnd.android.package-archive")
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(installIntent)
                call.resolve()
            } catch (e: Exception) {
                call.reject("APK update failed: ${e.message}")
            }
        }
    }

    fun emitDeepLink(url: String) {
        notifyListeners("deepLinkOpened", JSObject().put("url", url), true)
    }
}
