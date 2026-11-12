package com.deviceoperate.feishumorning;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Toast;

public class LaunchActivity extends Activity {
    private static final String[] FEISHU_PACKAGES = {
            "com.ss.android.lark",
            "com.larksuite.suite"
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prepareLockScreenWindow();
        requestDismissKeyguardIfAllowed();
        new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
            @Override
            public void run() {
                openFeishu();
            }
        }, 1200L);
    }

    private void prepareLockScreenWindow() {
        Window window = getWindow();
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setTurnScreenOn(true);
            setShowWhenLocked(true);
        }
    }

    private void requestDismissKeyguardIfAllowed() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        KeyguardManager keyguardManager = getSystemService(KeyguardManager.class);
        if (keyguardManager != null) {
            keyguardManager.requestDismissKeyguard(this, null);
        }
    }

    private void openFeishu() {
        PackageManager packageManager = getPackageManager();
        for (String packageName : FEISHU_PACKAGES) {
            Intent launchIntent = packageManager.getLaunchIntentForPackage(packageName);
            if (launchIntent != null) {
                launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                        | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
                startActivity(launchIntent);
                finish();
                return;
            }
        }
        Toast.makeText(this, "Feishu/Lark is not installed.", Toast.LENGTH_LONG).show();
        finish();
    }
}
