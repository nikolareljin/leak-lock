@ECHO OFF
SETLOCAL

SET DIR=%~dp0
SET WRAPPER_JAR=%DIR%\gradle\wrapper\gradle-wrapper.jar

IF NOT EXIST "%WRAPPER_JAR%" (
  ECHO gradle-wrapper.jar missing; attempting to download...
  IF NOT EXIST "%DIR%\gradle\wrapper" MKDIR "%DIR%\gradle\wrapper"
  SET URL=https://repo1.maven.org/maven2/org/gradle/gradle-wrapper/8.7/gradle-wrapper-8.7.jar
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing -Uri '%URL%' -OutFile '%WRAPPER_JAR%' } catch { exit 1 }"
)

SET CLASSPATH=%WRAPPER_JAR%

IF NOT "%JAVA_HOME%"=="" (
  SET JAVACMD=%JAVA_HOME%\bin\java.exe
) ELSE (
  SET JAVACMD=java
)

"%JAVACMD%" -classpath "%CLASSPATH%" org.gradle.wrapper.GradleWrapperMain %*

ENDLOCAL

