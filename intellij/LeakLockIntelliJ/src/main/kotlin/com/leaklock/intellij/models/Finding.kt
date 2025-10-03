package com.leaklock.intellij.models

data class Finding(
    val ruleName: String,
    val filePath: String,
    val line: Int,
    val preview: String,
)

