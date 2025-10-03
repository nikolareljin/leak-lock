plugins {
    kotlin("jvm") version "1.9.22"
    id("org.jetbrains.intellij") version "1.17.2"
}

group = providers.gradleProperty("pluginGroup").get()
version = providers.gradleProperty("pluginVersion").get()

repositories { mavenCentral() }

intellij {
    version.set(providers.gradleProperty("platformVersion").get())
    type.set("IC") // IntelliJ Community
    plugins.set(listOf())
}

tasks {
    patchPluginXml {
        sinceBuild.set("223")
        untilBuild.set(null as String?)
        changeNotes.set("Initial Leak Lock IntelliJ plugin")
    }
    publishPlugin { enabled = false }
}

dependencies {
    // Use platform's Gson
    compileOnly("com.google.code.gson:gson:2.10.1")
}

kotlin { jvmToolchain(17) }
