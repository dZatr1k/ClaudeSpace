import groovy.json.JsonSlurper
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    kotlin("jvm") version "2.4.21"
    `java-library`
}

val repoRoot: File = rootDir.resolve("../..").canonicalFile

group = "io.github.claudespace"
// same version as the desktop app and the APK (package.json)
version = (JsonSlurper().parse(repoRoot.resolve("package.json")) as Map<*, *>)["version"] as String

java {
    // bytecode the Android toolchain (D8) takes; the build itself runs on JDK 21
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
        allWarningsAsErrors.set(true)
    }
}

dependencies {
    api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0")
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0")
    implementation("com.hierynomus:sshj:0.41.2")
    // Ed25519 for the app's own key (the same version sshj brings)
    implementation("org.bouncycastle:bcprov-jdk18on:1.84")

    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:6.1.3")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher:6.1.3")
    // the SSH server the tests connect to (in-process, fake HOME)
    testImplementation("org.apache.sshd:sshd-core:2.20.1")
    testImplementation("org.apache.sshd:sshd-sftp:2.20.1")
    testRuntimeOnly("org.slf4j:slf4j-nop:2.0.17")
}

// The real agent, bundled into build/ so that these tests never race vitest over resources/agent.
val agentBundle by tasks.registering(Exec::class) {
    val out = layout.buildDirectory.dir("agent-bundle")
    inputs.dir(repoRoot.resolve("agent")).withPropertyName("agent")
    inputs.file(repoRoot.resolve("package.json")).withPropertyName("packageJson")
    outputs.dir(out)
    workingDir(repoRoot)
    commandLine("python3", "agent/build_manifest.py", "--out", out.get().asFile.path)
}

tasks.test {
    dependsOn(agentBundle)
    useJUnitPlatform()
    systemProperty("cs.root", repoRoot.path)
    systemProperty("cs.bundle", layout.buildDirectory.dir("agent-bundle").get().asFile.path)
    testLogging {
        events("failed", "skipped")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
        showStandardStreams = System.getenv("CS_DEBUG") != null
    }
}
