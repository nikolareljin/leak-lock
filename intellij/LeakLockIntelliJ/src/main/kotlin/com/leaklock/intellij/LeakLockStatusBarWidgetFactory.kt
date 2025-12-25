package com.leaklock.intellij

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.util.Consumer
import com.leaklock.intellij.status.LeakLockStatusBus
import com.leaklock.intellij.status.LeakLockStatusListener
import java.awt.Component
import java.awt.event.MouseEvent
import javax.swing.JLabel

class LeakLockStatusBarWidgetFactory : StatusBarWidgetFactory {
    override fun getId(): String = "leaklock-status"
    override fun getDisplayName(): String = "Leak Lock Status"
    override fun isAvailable(project: Project): Boolean = true
    override fun canBeEnabledOn(statusBar: StatusBar): Boolean = true
    override fun createWidget(project: Project): StatusBarWidget = Widget(project)
    override fun disposeWidget(widget: StatusBarWidget) {}
    override fun isConfigurable(): Boolean = false

    private class Widget(private val project: Project) : StatusBarWidget, StatusBarWidget.TextPresentation, LeakLockStatusListener {
        private var statusBar: StatusBar? = null
        @Volatile private var text: String = "Leak Lock: Ready"

        override fun ID(): String = "leaklock-status"
        override fun install(statusBar: StatusBar) {
            this.statusBar = statusBar
            project.messageBus.connect(this).subscribe(LeakLockStatusBus.TOPIC, this)
        }
        override fun dispose() {}

        // TextPresentation
        override fun getText(): String = text
        override fun getMaxPossibleText(): String = "Leak Lock: Scanning…"
        override fun getAlignment(): Float = Component.LEFT_ALIGNMENT
        override fun getTooltipText(): String = "Leak Lock status"
        override fun getClickConsumer(): Consumer<MouseEvent>? = Consumer {
            val tw = com.intellij.openapi.wm.ToolWindowManager.getInstance(project).getToolWindow("Leak Lock")
            tw?.activate(null)
        }

        override fun getPresentation(): StatusBarWidget.WidgetPresentation = this

        override fun statusChanged(text: String) {
            this.text = text
            statusBar?.updateWidget(ID())
        }
    }
}

