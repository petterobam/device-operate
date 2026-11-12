package com.deviceoperate.feishumorning;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.content.Intent;
import android.net.Uri;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;

public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        ensureNotificationChannel();
        requestNotificationPermission();
        long next = Scheduler.scheduleNext(this);
        setContentView(buildStatusView(next));
    }

    private LinearLayout buildStatusView(long next) {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setGravity(Gravity.CENTER);
        int padding = (int) (24 * getResources().getDisplayMetrics().density);
        layout.setPadding(padding, padding, padding, padding);

        TextView title = new TextView(this);
        title.setText("Feishu 9 AM Launcher");
        title.setTextSize(22);
        title.setGravity(Gravity.CENTER);
        layout.addView(title);

        TextView status = new TextView(this);
        status.setText("Daily 09:00 alarm is scheduled.\nNext run: "
                + Scheduler.formatTime(this, next)
                + "\n\nAt 09:00 this app wakes the screen and opens Feishu. Secure lock screens still require you to unlock the phone.");
        status.setTextSize(16);
        status.setGravity(Gravity.CENTER);
        status.setPadding(0, padding, 0, 0);
        layout.addView(status);
        return layout;
    }

    static void ensureNotificationChannel(Activity activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                Scheduler.CHANNEL_ID,
                activity.getString(com.deviceoperate.feishumorning.R.string.notification_channel),
                NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Wakes the screen and opens Feishu at 09:00.");
        NotificationManager manager = activity.getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(channel);
        }
    }

    private void ensureNotificationChannel() {
        ensureNotificationChannel(this);
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 100);
        }
    }
}
