package com.telegramdrive.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

class UploadForegroundService : Service() {

    companion object {
        const val CHANNEL_ID = "telegram_drive_transfers"
        const val NOTIFICATION_ID = 4201
        const val ACTION_START = "com.telegramdrive.app.ACTION_START_FG"
        const val ACTION_UPDATE = "com.telegramdrive.app.ACTION_UPDATE_FG"
        const val ACTION_STOP = "com.telegramdrive.app.ACTION_STOP_FG"
        const val EXTRA_TITLE = "title"
        const val EXTRA_BODY = "body"
        const val EXTRA_PROGRESS = "progress"
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
            else -> {
                val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Telegram Drive"
                val body = intent?.getStringExtra(EXTRA_BODY) ?: "Transferring files in background"
                val progress = intent?.getIntExtra(EXTRA_PROGRESS, -1) ?: -1
                val notification = buildNotification(title, body, progress)

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    startForeground(
                        NOTIFICATION_ID,
                        notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                    )
                } else {
                    startForeground(NOTIFICATION_ID, notification)
                }
            }
        }
        return START_STICKY
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val channel = NotificationChannel(
                CHANNEL_ID,
                "File Transfers",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Active Telegram Drive uploads and downloads"
                setShowBadge(false)
            }
            mgr.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(title: String, body: String, progress: Int): Notification {
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingOpen = PendingIntent.getActivity(
            this,
            0,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setContentIntent(pendingOpen)
            .setOngoing(true)
            .setOnlyAlertOnce(true)

        if (progress in 0..100) {
            builder.setProgress(100, progress, false)
        }

        return builder.build()
    }
}
