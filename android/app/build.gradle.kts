import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// One version for the whole product: the desktop app's package.json.
val version: String = Regex("\"version\":\\s*\"([^\"]+)\"").find(rootDir.resolve("../package.json").readText())!!.groupValues[1]
val versionParts = version.split(".").map { it.toInt() }

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
}

base {
    archivesName.set("Ciao-$version")
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("junit:junit:4.13.2")
}
