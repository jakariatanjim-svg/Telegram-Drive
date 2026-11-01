package com.telegramdrive.app

import android.Manifest
import android.app.Activity
import android.app.ActivityManager
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
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.io.BufferedReader
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.security.KeyStore
import java.security.SecureRandom
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@CapacitorPlugin(
    name = "TelegramDriveNative",
    permissions = [
        Permission(strings = [Manifest.permission.CAMERA], alias = "camera")
    ]
)
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

    private data class DownloadSinkEntry(
        val tempFile: File,
        val stream: FileOutputStream
    )

    private sealed class MediaStreamEvent {
        data class Header(
            val status: Int,
            val mimeType: String,
            val totalSize: Long,
            val start: Long,
            val end: Long,
            val acceptRanges: Boolean
        ) : MediaStreamEvent()
        class Chunk(val bytes: ByteArray) : MediaStreamEvent()
        data class End(val error: String? = null) : MediaStreamEvent()
    }

    private val ioExecutor = Executors.newCachedThreadPool()
    private val downloadSinks = ConcurrentHashMap<String, DownloadSinkEntry>()
    private val streamQueues = ConcurrentHashMap<String, LinkedBlockingQueue<MediaStreamEvent>>()
    private val mediaServerLock = Any()
    private var mediaServerSocket: ServerSocket? = null
    private var mediaServerPort: Int = 0
    private val mediaServerToken: String = run {
        val buf = ByteArray(18)
        SecureRandom().nextBytes(buf)
        buf.joinToString("") { "%02x".format(it) }
    }

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

                val am = appCtx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
                val memInfo = ActivityManager.MemoryInfo()
                am.getMemoryInfo(memInfo)
                val totalRamBytes = memInfo.totalMem
                val availRamBytes = memInfo.availMem
                // Physical 4 GB phones report ~3.55-3.85 GiB totalMem after hardware carveouts;
                // < 3.2 GiB identifies 1 GB, 2 GB, and <=3 GB ultra-low-RAM phones.
                val ultraLowRam = am.isLowRamDevice || totalRamBytes < 3435973836L
                val systemDataSaver = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    cm.restrictBackgroundStatus == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED
                } else {
                    false
                }

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
                    put("backgroundRestricted", systemDataSaver)
                    put("deviceRamBytes", totalRamBytes)
                    put("availableRamBytes", availRamBytes)
                    put("ultraLowRam", ultraLowRam)
                    put("systemDataSaver", systemDataSaver)
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
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
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
                    try {
                        context.contentResolver.takePersistableUriPermission(
                            uri,
                            Intent.FLAG_GRANT_READ_URI_PERMISSION
                        )
                    } catch (_: Throwable) {
                        // Some providers only grant session-scoped read permission
                    }

                    var displayName = "file_${System.currentTimeMillis()}"
                    var queriedSize = -1L
                    context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                        if (cursor.moveToFirst()) {
                            val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                            if (nameIdx >= 0 && !cursor.isNull(nameIdx)) {
                                displayName = cursor.getString(nameIdx) ?: displayName
                            }
                            val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
                            if (sizeIdx >= 0 && !cursor.isNull(sizeIdx)) {
                                queriedSize = cursor.getLong(sizeIdx)
                            }
                        }
                    }
                    if (queriedSize < 0L) {
                        try {
                            context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { afd ->
                                if (afd.length >= 0L) queriedSize = afd.length
                            }
                        } catch (_: Throwable) {
                            // Ignore
                        }
                    }

                    val mime = context.contentResolver.getType(uri) ?: "application/octet-stream"
                    // Zero-copy fast path for large files (>32 MB): stream directly from content:// URI
                    // during upload so multi-GB files never duplicate storage or spike RAM.
                    if (queriedSize > 32L * 1024L * 1024L) {
                        filesArr.put(
                            JSObject().apply {
                                put("uri", uri.toString())
                                put("name", displayName)
                                put("size", queriedSize)
                                put("mimeType", mime)
                                put("cachedPath", uri.toString())
                            }
                        )
                    } else {
                        val safeFile = File(pickedDir, "${System.currentTimeMillis()}_${displayName}")
                        context.contentResolver.openInputStream(uri)?.use { input ->
                            FileOutputStream(safeFile).use { output -> input.copyTo(output) }
                        }
                        filesArr.put(
                            JSObject().apply {
                                put("uri", uri.toString())
                                put("name", displayName)
                                put("size", safeFile.length())
                                put("mimeType", mime)
                                put("cachedPath", safeFile.absolutePath)
                            }
                        )
                    }
                }
                call.resolve(JSObject().put("files", filesArr))
            } catch (e: Exception) {
                call.reject("Failed to read picked files: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun getFileInfo(call: PluginCall) {
        val rawPath = call.getString("path") ?: return call.reject("Missing path")
        ioExecutor.execute {
            try {
                if (rawPath.startsWith("content://")) {
                    val uri = Uri.parse(rawPath)
                    var displayName = "file"
                    var size = -1L
                    context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                        if (cursor.moveToFirst()) {
                            val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                            if (nameIdx >= 0 && !cursor.isNull(nameIdx)) {
                                displayName = cursor.getString(nameIdx) ?: displayName
                            }
                            val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
                            if (sizeIdx >= 0 && !cursor.isNull(sizeIdx)) {
                                size = cursor.getLong(sizeIdx)
                            }
                        }
                    }
                    if (size < 0L) {
                        context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { afd ->
                            if (afd.length >= 0L) size = afd.length
                        }
                    }
                    val mime = context.contentResolver.getType(uri) ?: "application/octet-stream"
                    call.resolve(
                        JSObject().apply {
                            put("name", displayName)
                            put("size", if (size >= 0L) size else 0L)
                            put("mimeType", mime)
                        }
                    )
                } else {
                    val f = File(rawPath)
                    if (!f.exists()) {
                        call.reject("FILE_NOT_FOUND")
                        return@execute
                    }
                    call.resolve(
                        JSObject().apply {
                            put("name", f.name)
                            put("size", f.length())
                            put("mimeType", "application/octet-stream")
                        }
                    )
                }
            } catch (e: Exception) {
                call.reject("Failed to inspect file: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun readFileChunkBase64(call: PluginCall) {
        val rawPath = call.getString("path") ?: return call.reject("Missing path")
        val offset = (call.getDouble("offset") ?: 0.0).toLong().coerceAtLeast(0L)
        val length = (call.getInt("length") ?: (1024 * 1024)).coerceIn(1, 8 * 1024 * 1024)

        ioExecutor.execute {
            try {
                val buf = ByteArray(length)
                var totalRead = 0

                if (rawPath.startsWith("content://")) {
                    val uri = Uri.parse(rawPath)
                    val pfd = context.contentResolver.openFileDescriptor(uri, "r")
                    if (pfd != null) {
                        pfd.use { desc ->
                            FileInputStream(desc.fileDescriptor).use { fis ->
                                try {
                                    fis.channel.position(offset)
                                } catch (_: Throwable) {
                                    var remainingSkip = offset
                                    while (remainingSkip > 0) {
                                        val skipped = fis.skip(remainingSkip)
                                        if (skipped <= 0) break
                                        remainingSkip -= skipped
                                    }
                                }
                                while (totalRead < length) {
                                    val r = fis.read(buf, totalRead, length - totalRead)
                                    if (r <= 0) break
                                    totalRead += r
                                }
                            }
                        }
                    } else {
                        context.contentResolver.openInputStream(uri)?.use { ins ->
                            var remainingSkip = offset
                            while (remainingSkip > 0) {
                                val skipped = ins.skip(remainingSkip)
                                if (skipped <= 0) break
                                remainingSkip -= skipped
                            }
                            while (totalRead < length) {
                                val r = ins.read(buf, totalRead, length - totalRead)
                                if (r <= 0) break
                                totalRead += r
                            }
                        }
                    }
                } else {
                    val f = File(rawPath)
                    RandomAccessFile(f, "r").use { raf ->
                        if (offset < raf.length()) {
                            raf.seek(offset)
                            while (totalRead < length) {
                                val r = raf.read(buf, totalRead, length - totalRead)
                                if (r <= 0) break
                                totalRead += r
                            }
                        }
                    }
                }

                val encoded = if (totalRead > 0) {
                    Base64.encodeToString(buf, 0, totalRead, Base64.NO_WRAP)
                } else {
                    ""
                }
                call.resolve(
                    JSObject().apply {
                        put("data", encoded)
                        put("bytesRead", totalRead)
                    }
                )
            } catch (e: Exception) {
                call.reject("Failed to read file chunk: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun readFileBase64(call: PluginCall) {
        val filePath = call.getString("path") ?: return call.reject("Missing path")
        ioExecutor.execute {
            try {
                if (filePath.startsWith("content://")) {
                    val uri = Uri.parse(filePath)
                    var displayName = "file"
                    context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                        val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        if (idx >= 0 && cursor.moveToFirst() && !cursor.isNull(idx)) {
                            displayName = cursor.getString(idx) ?: displayName
                        }
                    }
                    val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                        ?: ByteArray(0)
                    val ret = JSObject().apply {
                        put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
                        put("name", displayName)
                        put("size", bytes.size)
                    }
                    call.resolve(ret)
                } else {
                    val f = File(filePath)
                    val bytes = f.readBytes()
                    val ret = JSObject().apply {
                        put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
                        put("name", f.name)
                        put("size", bytes.size)
                    }
                    call.resolve(ret)
                }
            } catch (e: Exception) {
                call.reject("Failed to read file: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun openDownloadSink(call: PluginCall) {
        val resumeKey = call.getString("resumeKey") ?: UUID.randomUUID().toString()
        val expectedTotal = (call.getDouble("expectedTotalBytes") ?: 0.0).toLong()
        ioExecutor.execute {
            try {
                val baseCache = context.externalCacheDir ?: context.cacheDir
                val dlTempDir = File(baseCache, "td_partial_downloads").apply { mkdirs() }
                val safeKey = resumeKey.replace(Regex("[^a-zA-Z0-9._-]"), "_")
                val tempFile = File(dlTempDir, "$safeKey.tdpart")

                val resumeUnit = 1024L * 1024L // 1 MiB alignment
                var existingBytes = 0L
                if (tempFile.exists() && expectedTotal > resumeUnit) {
                    val curLen = tempFile.length()
                    val aligned = (curLen / resumeUnit) * resumeUnit
                    if (aligned in 1 until expectedTotal) {
                        if (curLen != aligned) {
                            RandomAccessFile(tempFile, "rw").use { it.setLength(aligned) }
                        }
                        existingBytes = aligned
                    } else if (curLen >= expectedTotal) {
                        tempFile.delete()
                    }
                }

                val fos = FileOutputStream(tempFile, existingBytes > 0L)
                val sinkId = UUID.randomUUID().toString()
                downloadSinks[sinkId] = DownloadSinkEntry(tempFile, fos)
                call.resolve(
                    JSObject().apply {
                        put("sinkId", sinkId)
                        put("existingBytes", existingBytes)
                    }
                )
            } catch (e: Exception) {
                call.reject("Failed to open download sink: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun appendDownloadChunkBase64(call: PluginCall) {
        val sinkId = call.getString("sinkId") ?: return call.reject("Missing sinkId")
        val dataB64 = call.getString("data") ?: ""
        val sink = downloadSinks[sinkId] ?: return call.reject("DOWNLOAD_SINK_NOT_FOUND")
        ioExecutor.execute {
            try {
                if (dataB64.isNotEmpty()) {
                    val bytes = Base64.decode(dataB64, Base64.DEFAULT)
                    synchronized(sink) {
                        sink.stream.write(bytes)
                    }
                }
                call.resolve()
            } catch (e: Exception) {
                call.reject("Failed to write download chunk: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun finalizeDownloadSink(call: PluginCall) {
        val sinkId = call.getString("sinkId") ?: return call.reject("Missing sinkId")
        val directory = call.getString("directory") ?: "downloads"
        val filename = call.getString("filename") ?: "telegram_file"
        val mimeType = call.getString("mimeType") ?: "application/octet-stream"
        val sink = downloadSinks.remove(sinkId) ?: return call.reject("DOWNLOAD_SINK_NOT_FOUND")

        ioExecutor.execute {
            try {
                synchronized(sink) {
                    sink.stream.flush()
                    sink.stream.close()
                }
                if (directory == "downloads" && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val values = ContentValues().apply {
                        put(MediaStore.Downloads.DISPLAY_NAME, filename)
                        put(MediaStore.Downloads.MIME_TYPE, mimeType)
                        put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Telegram Drive")
                    }
                    val uri = context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                        ?: throw IllegalStateException("Could not create Downloads entry")
                    context.contentResolver.openOutputStream(uri)?.use { out ->
                        FileInputStream(sink.tempFile).use { input ->
                            val buf = ByteArray(64 * 1024)
                            while (true) {
                                val r = input.read(buf)
                                if (r <= 0) break
                                out.write(buf, 0, r)
                            }
                        }
                    }
                    sink.tempFile.delete()
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
                    FileInputStream(sink.tempFile).use { input ->
                        FileOutputStream(outFile).use { out ->
                            val buf = ByteArray(64 * 1024)
                            while (true) {
                                val r = input.read(buf)
                                if (r <= 0) break
                                out.write(buf, 0, r)
                            }
                        }
                    }
                    sink.tempFile.delete()
                    call.resolve(
                        JSObject().apply {
                            put("path", outFile.absolutePath)
                            put("uri", Uri.fromFile(outFile).toString())
                        }
                    )
                }
            } catch (e: Exception) {
                call.reject("Failed to finalize download: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun abortDownloadSink(call: PluginCall) {
        val sinkId = call.getString("sinkId") ?: return call.resolve()
        val deletePartial = call.getBoolean("deletePartial") ?: false
        val sink = downloadSinks.remove(sinkId)
        ioExecutor.execute {
            if (sink != null) {
                try {
                    synchronized(sink) {
                        sink.stream.close()
                    }
                } catch (_: Throwable) {
                    // Ignore
                }
                if (deletePartial) {
                    sink.tempFile.delete()
                }
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun startLocalMediaServer(call: PluginCall) {
        ioExecutor.execute {
            try {
                synchronized(mediaServerLock) {
                    if (mediaServerSocket == null || mediaServerSocket!!.isClosed) {
                        val srv = ServerSocket(0, 32, InetAddress.getByName("127.0.0.1"))
                        mediaServerSocket = srv
                        mediaServerPort = srv.localPort
                        ioExecutor.execute {
                            while (!srv.isClosed) {
                                val clientSocket = try {
                                    srv.accept()
                                } catch (_: Throwable) {
                                    break
                                }
                                ioExecutor.execute { handleLocalMediaClient(clientSocket) }
                            }
                        }
                    }
                }
                call.resolve(
                    JSObject().apply {
                        put("port", mediaServerPort)
                        put("token", mediaServerToken)
                        put("baseUrl", "http://127.0.0.1:$mediaServerPort")
                    }
                )
            } catch (e: Exception) {
                call.reject("Failed to start local media server: ${e.message}")
            }
        }
    }

    private fun handleLocalMediaClient(socket: Socket) {
        val reqId = UUID.randomUUID().toString()
        var registeredQueue = false
        try {
            socket.soTimeout = 35_000
            val reader = BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.UTF_8))
            val requestLine = reader.readLine() ?: return
            val parts = requestLine.split(" ")
            if (parts.size < 2) return
            val method = parts[0].uppercase()
            val rawTarget = parts[1]

            var rangeHeader = ""
            while (true) {
                val hdr = reader.readLine()
                if (hdr.isNullOrEmpty()) break
                if (hdr.startsWith("Range:", ignoreCase = true)) {
                    rangeHeader = hdr.substringAfter(":").trim()
                }
            }

            val out = socket.getOutputStream()
            if (method == "OPTIONS") {
                val resp = buildString {
                    append("HTTP/1.1 204 No Content\r\n")
                    append("Access-Control-Allow-Origin: *\r\n")
                    append("Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n")
                    append("Access-Control-Allow-Headers: Range\r\n")
                    append("Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n")
                    append("Connection: close\r\n\r\n")
                }
                out.write(resp.toByteArray(Charsets.UTF_8))
                out.flush()
                return
            }

            val parsedUri = Uri.parse("http://127.0.0.1$rawTarget")
            val token = parsedUri.getQueryParameter("token") ?: ""
            if (token != mediaServerToken) {
                out.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray(Charsets.UTF_8))
                out.flush()
                return
            }

            val segments = parsedUri.pathSegments
            if (segments.size < 3 || segments[0] != "stream") {
                out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray(Charsets.UTF_8))
                out.flush()
                return
            }
            val folderSeg = segments[1]
            val msgId = segments[2].toLongOrNull() ?: 0L

            val queue = LinkedBlockingQueue<MediaStreamEvent>(48)
            streamQueues[reqId] = queue
            registeredQueue = true

            notifyListeners(
                "mediaStreamRequest",
                JSObject().apply {
                    put("reqId", reqId)
                    put("method", method)
                    put("folder", folderSeg)
                    put("messageId", msgId)
                    put("range", rangeHeader)
                }
            )

            val firstEvent = queue.poll(25, TimeUnit.SECONDS)
            if (firstEvent !is MediaStreamEvent.Header) {
                out.write("HTTP/1.1 504 Gateway Timeout\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray(Charsets.UTF_8))
                out.flush()
                return
            }

            val statusText = when (firstEvent.status) {
                206 -> "206 Partial Content"
                200 -> "200 OK"
                416 -> "416 Range Not Satisfiable"
                else -> "${firstEvent.status} Error"
            }
            val contentLength = if (firstEvent.status in listOf(200, 206) && firstEvent.end >= firstEvent.start && firstEvent.totalSize > 0) {
                (firstEvent.end - firstEvent.start + 1L).coerceAtLeast(0L)
            } else {
                0L
            }

            val headersText = buildString {
                append("HTTP/1.1 $statusText\r\n")
                append("Content-Type: ${firstEvent.mimeType}\r\n")
                if (firstEvent.acceptRanges) {
                    append("Accept-Ranges: bytes\r\n")
                }
                if (firstEvent.status == 206 && firstEvent.totalSize > 0) {
                    append("Content-Range: bytes ${firstEvent.start}-${firstEvent.end}/${firstEvent.totalSize}\r\n")
                }
                append("Content-Length: $contentLength\r\n")
                append("Access-Control-Allow-Origin: *\r\n")
                append("Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n")
                append("Cache-Control: no-store\r\n")
                append("Connection: close\r\n\r\n")
            }
            out.write(headersText.toByteArray(Charsets.UTF_8))
            out.flush()

            if (method == "HEAD" || firstEvent.status !in listOf(200, 206) || contentLength == 0L) {
                return
            }

            var written = 0L
            while (written < contentLength) {
                val ev = queue.poll(30, TimeUnit.SECONDS) ?: break
                when (ev) {
                    is MediaStreamEvent.Chunk -> {
                        if (ev.bytes.isNotEmpty()) {
                            val toWrite = minOf(ev.bytes.size.toLong(), contentLength - written).toInt()
                            out.write(ev.bytes, 0, toWrite)
                            out.flush()
                            written += toWrite
                        }
                    }
                    is MediaStreamEvent.End -> break
                    else -> Unit
                }
            }
        } catch (_: Throwable) {
            // Player closed socket on seek/pause
        } finally {
            if (registeredQueue) {
                streamQueues.remove(reqId)
                notifyListeners("mediaStreamAbort", JSObject().put("reqId", reqId))
            }
            try {
                socket.close()
            } catch (_: Throwable) {
                // Ignore
            }
        }
    }

    @PluginMethod
    fun respondMediaStreamHeader(call: PluginCall) {
        val reqId = call.getString("reqId") ?: return call.resolve()
        val status = call.getInt("status") ?: 200
        val mimeType = call.getString("mimeType") ?: "application/octet-stream"
        val totalSize = (call.getDouble("totalSize") ?: 0.0).toLong()
        val start = (call.getDouble("start") ?: 0.0).toLong()
        val end = (call.getDouble("end") ?: 0.0).toLong()
        val acceptRanges = call.getBoolean("acceptRanges") ?: true
        streamQueues[reqId]?.offer(
            MediaStreamEvent.Header(status, mimeType, totalSize, start, end, acceptRanges)
        )
        call.resolve()
    }

    @PluginMethod
    fun pushMediaStreamChunk(call: PluginCall) {
        val reqId = call.getString("reqId") ?: return call.resolve()
        val dataB64 = call.getString("data") ?: ""
        val queue = streamQueues[reqId]
        if (queue == null) {
            call.resolve(JSObject().put("closed", true))
            return
        }
        ioExecutor.execute {
            try {
                if (dataB64.isNotEmpty()) {
                    val bytes = Base64.decode(dataB64, Base64.DEFAULT)
                    val ok = queue.offer(MediaStreamEvent.Chunk(bytes), 15, TimeUnit.SECONDS)
                    call.resolve(JSObject().put("closed", !ok))
                } else {
                    call.resolve(JSObject().put("closed", false))
                }
            } catch (_: Throwable) {
                call.resolve(JSObject().put("closed", true))
            }
        }
    }

    @PluginMethod
    fun endMediaStream(call: PluginCall) {
        val reqId = call.getString("reqId") ?: return call.resolve()
        val error = call.getString("error")
        streamQueues[reqId]?.offer(MediaStreamEvent.End(error))
        call.resolve()
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

    @PluginMethod
    fun ensureCameraPermission(call: PluginCall) {
        if (getPermissionState("camera") == PermissionState.GRANTED) {
            call.resolve(JSObject().put("granted", true))
        } else {
            requestPermissionForAlias("camera", call, "cameraPermissionsCallback")
        }
    }

    @PermissionCallback
    private fun cameraPermissionsCallback(call: PluginCall) {
        val granted = getPermissionState("camera") == PermissionState.GRANTED
        call.resolve(JSObject().put("granted", granted))
    }

    fun emitDeepLink(url: String) {
        notifyListeners("deepLinkOpened", JSObject().put("url", url), true)
    }
}
