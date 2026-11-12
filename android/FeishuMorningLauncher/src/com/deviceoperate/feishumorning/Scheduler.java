package com.deviceoperate.feishumorning;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import java.text.DateFormat;
import java.util.Calendar;
import java.util.Date;

final class Scheduler {
    static final int HOUR = 9;
    static final int MINUTE = 0;
    static final String CHANNEL_ID = "feishu_morning_launcher";
    static final String ACTION_OPEN_FEISHU = "com.deviceoperate.feishumorning.OPEN_FEISHU";

    private Scheduler() {
    }

    static long scheduleNext(Context context) {
        Calendar next = Calendar.getInstance();
        next.set(Calendar.HOUR_OF_DAY, HOUR);
        next.set(Calendar.MINUTE, MINUTE);
        next.set(Calendar.SECOND, 0);
        next.set(Calendar.MILLISECOND, 0);
        if (next.getTimeInMillis() <= System.currentTimeMillis()) {
            next.add(Calendar.DAY_OF_YEAR, 1);
        }

        Intent receiverIntent = new Intent(context, AlarmReceiver.class);
        receiverIntent.setAction(ACTION_OPEN_FEISHU);
        PendingIntent operation = PendingIntent.getBroadcast(
                context,
                900,
                receiverIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | immutableFlag()
        );

        Intent showIntent = new Intent(context, MainActivity.class);
        PendingIntent showOperation = PendingIntent.getActivity(
                context,
                901,
                showIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | immutableFlag()
        );

        AlarmManager alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarmManager != null) {
            AlarmManager.AlarmClockInfo info =
                    new AlarmManager.AlarmClockInfo(next.getTimeInMillis(), showOperation);
            alarmManager.setAlarmClock(info, operation);
        }
        return next.getTimeInMillis();
    }

    static PendingIntent launchPendingIntent(Context context) {
        Intent intent = new Intent(context, LaunchActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
                context,
                902,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | immutableFlag()
        );
    }

    static int immutableFlag() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0;
    }

    static String formatTime(Context context, long timeMillis) {
        return DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT)
                .format(new Date(timeMillis));
    }
}
