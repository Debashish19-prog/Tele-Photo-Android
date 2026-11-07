import java.util.Properties

plugins {
    id("com.android.application")
}

/** A build holding demo data instead of a Telegram login. It can sit beside the real one on a phone. */
val demoBuild = providers.gradleProperty("demoBuild").map { it == "true" }.getOrElse(false)

/** Created by `pnpm android:keystore`, and never committed. Losing it means reinstalling to update. */
val keystoreProperties = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "app.telephoto"
    compileSdk {
        version = release(37)
    }

    defaultConfig {
        applicationId = "app.telephoto"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        if (demoBuild) {
            applicationIdSuffix = ".demo"
            resValue("string", "app_name", "Tele-Photo Demo")
        } else {
            resValue("string", "app_name", "Tele-Photo")
        }
    }

    signingConfigs {
        if (keystoreProperties.isNotEmpty()) {
            create("release") {
                storeFile = rootProject.file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            // Nothing to shrink: there are no libraries, and the web code is already minified.
            optimization {
                enable = false
            }
            if (keystoreProperties.isNotEmpty()) signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        resValues = true
    }
}

/** The app serves the built website from inside the APK, so the APK works with no network but Telegram's. */
val copyWebApp by tasks.registering(Sync::class) {
    val built = rootProject.file("../web/dist")
    from(built)
    into(layout.projectDirectory.dir("src/main/assets/www"))
    doFirst {
        if (!built.resolve("index.html").exists()) {
            throw GradleException("The website has not been built. From the top of the repo, run: pnpm build")
        }
    }
}

tasks.named("preBuild") { dependsOn(copyWebApp) }
