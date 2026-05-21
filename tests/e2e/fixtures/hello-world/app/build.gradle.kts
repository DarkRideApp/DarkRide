plugins {
    id("com.android.application")
    kotlin("android")
}

android {
    namespace = "wiki.themeparks.darkride.e2efixture"
    compileSdk = 34

    defaultConfig {
        applicationId = "wiki.themeparks.darkride.e2efixture"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        debug {
            // No code shrinking — keeps the build fast.
            isMinifyEnabled = false
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

dependencies {
    // No deps — keeps the APK tiny.
}
