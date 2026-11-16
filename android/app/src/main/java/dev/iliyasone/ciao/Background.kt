package dev.iliyasone.ciao

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings

/**
 * Keeping Ciao alive in the background. Android's own battery optimization can be checked and
 * lifted; on top of it Huawei, Honor and Xiaomi have their own app launch screens, which can be
 * opened but not read, so the setup asks the user to confirm those.
 */
object Background {
    enum class Maker { HUAWEI, HONOR, XIAOMI, SAMSUNG, OTHER }

    val maker: Maker
        get() = when (Build.MANUFACTURER.lowercase()) {
            "huawei" -> Maker.HUAWEI
            "honor" -> Maker.HONOR
            "xiaomi", "redmi", "poco" -> Maker.XIAOMI
            "samsung" -> Maker.SAMSUNG
            else -> Maker.OTHER
        }

    /** The maker has a launch manager of its own that stops services Android would keep. */
    val hasLaunchManager get() = maker == Maker.HUAWEI || maker == Maker.HONOR || maker == Maker.XIAOMI

    fun unrestricted(activity: Activity): Boolean =
        activity.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(activity.packageName)

    /** Android's prompt to stop optimizing Ciao's battery use. */
    @SuppressLint("BatteryLife") // a dictation service has to stay connected; this app isn't on Play
    fun askUnrestricted(activity: Activity) {
        val ask = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${activity.packageName}"))
        if (runCatching { activity.startActivity(ask) }.isFailure) runCatching { activity.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
    }

    /** The maker's app launch screen, or App info when none of the known ones opens. */
    fun openLaunchManager(activity: Activity) {
        val screens = when (maker) {
            Maker.HUAWEI -> listOf(
                "com.huawei.systemmanager" to "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
                "com.huawei.systemmanager" to "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity",
                "com.huawei.systemmanager" to "com.huawei.systemmanager.optimize.process.ProtectActivity",
            )
            Maker.HONOR -> listOf(
                "com.hihonor.systemmanager" to "com.hihonor.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
                "com.huawei.systemmanager" to "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
            )
            Maker.XIAOMI -> listOf("com.miui.securitycenter" to "com.miui.permcenter.autostart.AutoStartManagementActivity")
            else -> emptyList()
        }
        for ((pkg, cls) in screens) {
            if (runCatching { activity.startActivity(Intent().setComponent(ComponentName(pkg, cls))) }.isSuccess) return
        }
        appInfo(activity)
    }

    fun appInfo(activity: Activity) {
        activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", activity.packageName, null)))
    }
}
