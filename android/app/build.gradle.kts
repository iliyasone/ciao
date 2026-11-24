import java.net.URI
import java.security.MessageDigest
import java.util.Properties
import java.util.zip.GZIPInputStream

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
    // For the on-device recognizer's library (buildAsr below); CI installs this one.
    ndkVersion = "28.2.13676358"

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
    sourceSets["main"].jniLibs.srcDir(layout.buildDirectory.dir("asr/jniLibs"))
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("asr/assets"))
    // Stored as they are, so the recognizer reads its models straight from the APK (LocalAsr.kt).
    androidResources {
        noCompress += listOf("tzf", "onnx")
    }
    // Robolectric runs the real activities on the JVM (UiTest.kt): no emulator, in CI too.
    testOptions {
        unitTests.isIncludeAndroidResources = true
    }
}

// The on-device recognizer (tinyasr, LocalAsr.kt): native/asr built for every ABI Android has, and its model files,
// fetched as the desktop's scripts/build-asr.mjs fetches them: from the commit and with the SHA-256 it names.
val asrCrate = rootDir.resolve("../native/asr")
val asrTargets = mapOf(
    "arm64-v8a" to "aarch64-linux-android",
    "armeabi-v7a" to "armv7-linux-androideabi",
    "x86_64" to "x86_64-linux-android",
    "x86" to "i686-linux-android",
)

fun runTool(vararg command: String, env: Map<String, String> = emptyMap()) {
    val p = ProcessBuilder(*command).inheritIO().apply { environment().putAll(env) }.start()
    check(p.waitFor() == 0) { "${command.joinToString(" ")} failed" }
}

val buildAsr by tasks.registering {
    val sdk = androidComponents.sdkComponents.sdkDirectory
    val ndkVersion = android.ndkVersion
    val minSdk = android.defaultConfig.minSdk!!
    val out = layout.buildDirectory.dir("asr/jniLibs")
    inputs.dir(asrCrate.resolve("src"))
    inputs.files(asrCrate.resolve("Cargo.toml"), asrCrate.resolve("Cargo.lock"))
    outputs.dir(out)
    doLast {
        val os = System.getProperty("os.name").lowercase()
        val host = if ("mac" in os) "darwin-x86_64" else if ("windows" in os) "windows-x86_64" else "linux-x86_64"
        val bin = sdk.get().asFile.resolve("ndk/$ndkVersion/toolchains/llvm/prebuilt/$host/bin")
        runTool("rustup", "target", "add", *asrTargets.values.toTypedArray())
        for ((abi, target) in asrTargets) {
            val clang = target.replace("armv7-", "armv7a-") + minSdk + "-clang" + if ("windows" in os) ".cmd" else ""
            runTool(
                "cargo", "build", "--release", "--lib", "--target", target, "--manifest-path", asrCrate.resolve("Cargo.toml").path,
                env = mapOf("CARGO_TARGET_${target.uppercase().replace('-', '_')}_LINKER" to bin.resolve(clang).path),
            )
            val dir = out.get().asFile.resolve(abi).apply { mkdirs() }
            asrCrate.resolve("target/$target/release/libciao_asr.so").copyTo(dir.resolve("libciao_asr.so"), overwrite = true)
        }
    }
}

val fetchAsrModels by tasks.registering {
    val script = rootDir.resolve("../scripts/build-asr.mjs")
    val out = layout.buildDirectory.dir("asr/assets/tinyasr")
    inputs.file(script)
    outputs.dir(out)
    doLast {
        val source = script.readText()
        val rev = Regex("""const REV = "(\w+)"""").find(source)!!.groupValues[1]
        // Path in tinyasr's repo -> SHA-256 of the file as shipped (the .gz ones unpacked); its LICENSE too.
        val files = Regex("""^\s*"?([\w./-]+)"?: "([0-9a-f]{64})"""", RegexOption.MULTILINE).findAll(source).associate { it.groupValues[1] to it.groupValues[2] }
        check(files.keys.any { it.endsWith(".tzf.gz") }) { "no model files in $script" }
        fun sha(f: File) = MessageDigest.getInstance("SHA-256").digest(f.readBytes()).joinToString("") { "%02x".format(it) }
        for ((src, hash) in files) {
            val name = src.substringAfterLast('/').removeSuffix(".gz")
            val file = out.get().asFile.apply { mkdirs() }.resolve(name)
            if (file.exists() && sha(file) == hash) continue
            // The desktop build's copy, when there is one.
            val desktop = rootDir.resolve("../build/tinyasr/$name")
            if (desktop.exists() && sha(desktop) == hash) {
                desktop.copyTo(file, overwrite = true)
                continue
            }
            URI("https://raw.githubusercontent.com/dkaraush/tinyasr/$rev/$src").toURL().openStream().use { body ->
                (if (src.endsWith(".gz")) GZIPInputStream(body) else body).use { i -> file.outputStream().use { i.copyTo(it) } }
            }
            check(sha(file) == hash) { "$name: SHA-256 doesn't match" }
        }
    }
}

tasks.named("preBuild") { dependsOn(buildAsr, fetchAsrModels) }

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
