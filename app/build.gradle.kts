plugins {
    id("com.android.application")
}

android {
    namespace = "com.teamdark.darkagent"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.teamdark.darkagent"
        minSdk = 24
        targetSdk = 34
        versionCode = 5
        versionName = "2.0.0"
    }

    buildTypes {
        debug {
            applicationIdSuffix = ""
        }
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = false
    }
}

dependencies {
}
