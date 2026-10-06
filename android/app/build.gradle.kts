import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// One version for the whole product: the desktop app's package.json.
val version: String = Regex("\"version\":\\s*\"([^\"]+)\"").find(rootDir.resolve("../package.json").readText())!!.groupValues[1]
// versionCode = MAJOR*10000 + MINOR*100 + PATCH, so each part must stay below 100.
val versionParts = Regex("(\\d+)\\.(\\d+)\\.(\\d+)").matchEntire(version)?.groupValues?.drop(1)?.map { it.toInt() }
    ?.takeIf { parts -> parts.all { it < 100 } }
    ?: error("package.json version $version must be X.Y.Z with each part below 100 for the Android versionCode")

// Release signing comes from the environment (CI secrets) or android/keystore.properties; without
// either, release builds are signed with the debug key, which is fine for trying a build locally.
val keystoreProps = Properties().apply {
    val f = rootDir.resolve("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun signingValue(env: String, prop: String): String? = System.getenv(env)?.takeIf { it.isNotBlank() } ?: keystoreProps.getProperty(prop)
val keystoreFile = signingValue("CIAO_KEYSTORE_FILE", "storeFile")

android {
    namespace = "dev.iliyasone.ciao"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.iliyasone.ciao"
        minSdk = 26
        targetSdk = 35
        versionCode = versionParts[0] * 10000 + versionParts[1] * 100 + versionParts[2]
        versionName = version
    }

    signingConfigs {
        if (keystoreFile != null) {
            create("release") {
                storeFile = file(keystoreFile)
                storePassword = signingValue("CIAO_KEYSTORE_PASSWORD", "storePassword")
                keyAlias = signingValue("CIAO_KEY_ALIAS", "keyAlias")
                keyPassword = signingValue("CIAO_KEY_PASSWORD", "keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    // Robolectric runs the real activities on the JVM (UiTest.kt): no emulator, in CI too.
    testOptions {
        unitTests.isIncludeAndroidResources = true
    }
}

base {
    archivesName.set("Ciao-$version")
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // Google sign-in for syncing terms (GoogleSync.kt).
    implementation("com.google.android.gms:play-services-auth:21.2.0")
    testImplementation("junit:junit:4.13.2")
    // The real org.json for unit tests (Android's is a stub there).
    testImplementation("org.json:json:20240303")
    testImplementation("org.robolectric:robolectric:4.14.1")
}
