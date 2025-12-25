package com.leaklock.intellij

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import com.leaklock.intellij.models.Finding
import com.leaklock.intellij.services.BfgService
import com.leaklock.intellij.services.ScannerService
import java.awt.BorderLayout
import java.awt.Dimension
import java.io.File
import javax.swing.*
import javax.swing.table.DefaultTableModel
import com.leaklock.intellij.status.LeakLockStatusBus

class LeakLockPanel(private val project: Project) {
    val root: JPanel = JPanel(BorderLayout())

    private val directoryField = JTextField()
    private val installDepsButton = JButton("Install Dependencies")
    private val browseButton = JButton("Browse…")
    private val scanButton = JButton("Scan")
    private val openFileButton = JButton("Open File")
    private val runBfgButton = JButton("Run BFG + Cleanup")

    private val tableModel = object : DefaultTableModel(arrayOf("Type", "File", "Line", "Preview"), 0) {
        override fun isCellEditable(row: Int, column: Int) = false
    }
    private val table = JTable(tableModel)

    private val scanner = ScannerService()
    private val bfg = BfgService()

    init {
        val top = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            add(installDepsButton)
            add(Box.createHorizontalStrut(8))
            add(JLabel("Directory:"))
            add(Box.createHorizontalStrut(4))
            directoryField.preferredSize = Dimension(420, directoryField.preferredSize.height)
            add(directoryField)
            add(Box.createHorizontalStrut(4))
            add(browseButton)
            add(Box.createHorizontalStrut(8))
            add(scanButton)
        }

        val bottom = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            add(Box.createHorizontalGlue())
            add(openFileButton)
            add(Box.createHorizontalStrut(8))
            add(runBfgButton)
        }

        table.autoResizeMode = JTable.AUTO_RESIZE_SUBSEQUENT_COLUMNS
        table.columnModel.getColumn(0).preferredWidth = 160
        table.columnModel.getColumn(1).preferredWidth = 480
        table.columnModel.getColumn(2).preferredWidth = 60
        table.columnModel.getColumn(3).preferredWidth = 540

        root.add(top, BorderLayout.NORTH)
        root.add(JScrollPane(table), BorderLayout.CENTER)
        root.add(bottom, BorderLayout.SOUTH)

        directoryField.text = project.basePath ?: ""

        installDepsButton.addActionListener { installDeps() }
        browseButton.addActionListener { chooseDirectory() }
        scanButton.addActionListener { runScan() }
        openFileButton.addActionListener { openSelectedFile() }
        runBfgButton.addActionListener { runBfg() }
        table.addMouseListener(object : java.awt.event.MouseAdapter() {
            override fun mouseClicked(e: java.awt.event.MouseEvent) {
                if (e.clickCount == 2) openSelectedFile()
            }
        })
    }

    // Public entry point for external actions
    fun startScan(targetDir: String?) {
        if (!targetDir.isNullOrBlank()) {
            directoryField.text = targetDir
        }
        runScan()
    }

    private fun installDeps() {
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Installing Leak Lock Dependencies", false) {
            override fun run(indicator: ProgressIndicator) {
                try {
                    indicator.isIndeterminate = false
                    var stage = 0
                    val totalStages = 3
                    scanner.installDependencies { msg ->
                        stage++
                        indicator.text = msg
                        indicator.fraction = stage.toDouble() / totalStages
                        LeakLockStatusBus.set(project, "Leak Lock: ${'$'}msg")
                    }
                    ApplicationManager.getApplication().invokeLater {
                        Messages.showInfoMessage(project, "Dependencies verified/installed.", "Leak Lock")
                        LeakLockStatusBus.set(project, "Leak Lock: Ready")
                    }
                } catch (t: Throwable) {
                    ApplicationManager.getApplication().invokeLater {
                        Messages.showErrorDialog(project, "Failed to install dependencies: ${'$'}{t.message}", "Leak Lock")
                        LeakLockStatusBus.set(project, "Leak Lock: Error")
                    }
                }
            }
        })
    }

    private fun chooseDirectory() {
        val chooser = JFileChooser().apply { fileSelectionMode = JFileChooser.DIRECTORIES_ONLY }
        val result = chooser.showOpenDialog(root)
        if (result == JFileChooser.APPROVE_OPTION) {
            directoryField.text = chooser.selectedFile.absolutePath
        }
    }

    private fun runScan() {
        val dir = directoryField.text.trim()
        if (dir.isEmpty() || !File(dir).exists()) {
            Messages.showWarningDialog(project, "Please select a valid directory.", "Leak Lock")
            return
        }

        tableModel.rowCount = 0
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Scanning for Secrets", false) {
            override fun run(indicator: ProgressIndicator) {
                try {
                    indicator.isIndeterminate = false
                    var stage = 0
                    val totalStages = 3
                    LeakLockStatusBus.set(project, "Leak Lock: Scanning…")
                    val results = scanner.scan(dir) { msg ->
                        stage++
                        indicator.text = msg
                        indicator.fraction = stage.toDouble() / totalStages
                        LeakLockStatusBus.set(project, "Leak Lock: ${'$'}msg")
                    }
                    ApplicationManager.getApplication().invokeLater {
                        results.forEach { f ->
                            tableModel.addRow(arrayOf(f.ruleName, f.filePath, f.line, f.preview))
                        }
                        if (results.isEmpty()) {
                            Messages.showInfoMessage(project, "No secrets found.", "Leak Lock")
                        }
                        LeakLockStatusBus.set(project, "Leak Lock: Ready")
                    }
                } catch (t: Throwable) {
                    ApplicationManager.getApplication().invokeLater {
                        Messages.showErrorDialog(project, "Scan failed: ${'$'}{t.message}", "Leak Lock")
                        LeakLockStatusBus.set(project, "Leak Lock: Error")
                    }
                }
            }
        })
    }

    private fun openSelectedFile() {
        val row = table.selectedRow
        if (row < 0) return
        val path = (tableModel.getValueAt(row, 1) as? String) ?: return
        val line = (tableModel.getValueAt(row, 2) as? Int) ?: 0
        val vFile = LocalFileSystem.getInstance().findFileByIoFile(File(path)) ?: return
        OpenFileDescriptor(project, vFile, (line - 1).coerceAtLeast(0), 0).navigate(true)
    }

    private fun runBfg() {
        val dir = directoryField.text.trim()
        if (dir.isEmpty() || !File(dir).exists()) {
            Messages.showWarningDialog(project, "Please select a valid directory.", "Leak Lock")
            return
        }
        if (tableModel.rowCount == 0) {
            Messages.showInfoMessage(project, "No findings to remove. Run a scan first.", "Leak Lock")
            return
        }
        val confirm = Messages.showYesNoDialog(project,
            "This will rewrite git history for '$dir'. Ensure you have a backup. Continue?",
            "Leak Lock",
            null)
        if (confirm != Messages.YES) return

        val findings = mutableListOf<Finding>()
        for (i in 0 until tableModel.rowCount) {
            findings.add(
                Finding(
                    tableModel.getValueAt(i, 0)?.toString() ?: "",
                    tableModel.getValueAt(i, 1)?.toString() ?: "",
                    (tableModel.getValueAt(i, 2) as? Int) ?: 0,
                    tableModel.getValueAt(i, 3)?.toString() ?: ""
                )
            )
        }

        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Running BFG Cleanup", false) {
            override fun run(indicator: ProgressIndicator) {
                try {
                    indicator.isIndeterminate = true
                    LeakLockStatusBus.set(project, "Leak Lock: Running BFG…")
                    bfg.runCleanup(dir, findings)
                    ApplicationManager.getApplication().invokeLater {
                        Messages.showInfoMessage(project, "BFG cleanup completed. Review changes and force-push if needed.", "Leak Lock")
                        LeakLockStatusBus.set(project, "Leak Lock: Ready")
                    }
                } catch (t: Throwable) {
                    ApplicationManager.getApplication().invokeLater {
                        Messages.showErrorDialog(project, "BFG cleanup failed: ${'$'}{t.message}", "Leak Lock")
                        LeakLockStatusBus.set(project, "Leak Lock: Error")
                    }
                }
            }
        })
    }
}
