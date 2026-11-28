Option Explicit

' ArkTalk Launcher (ASCII-only to avoid Windows Script Host ANSI/UTF-8 issues).
' Picks the highest-version ArkTalk-x.y.z-win64 folder under dist and runs it.
' Desktop shortcut points here; upgrade = just unzip new version into dist.

Dim fso, distDir, folder, subFolder
Dim bestVer, bestFolder, curVer, exePath
Dim shell, dryRun

' VBScript "And" is NOT short-circuit: must guard index access with nested If,
' otherwise WScript.Arguments(0) is evaluated even when Count = 0 (double-click case).
dryRun = False
If WScript.Arguments.Count > 0 Then
    If LCase(WScript.Arguments(0)) = "/dryrun" Then dryRun = True
End If
distDir = "E:\2026-11-26-20-49-26\snow-chat\dist"

Set fso = CreateObject("Scripting.FileSystemObject")

If Not fso.FolderExists(distDir) Then
    Fail "dist folder not found: " & distDir
End If

bestVer = ""
bestFolder = ""
Set folder = fso.GetFolder(distDir)

For Each subFolder In folder.SubFolders
    curVer = ParseVersion(subFolder.Name)
    If curVer <> "" Then
        If fso.FileExists(subFolder.Path & "\ArkTalk.exe") Then
            If curVer > bestVer Then
                bestVer = curVer
                bestFolder = subFolder.Path
            End If
        End If
    End If
Next

If bestFolder = "" Then
    Fail "No usable ArkTalk version found in dist (need ArkTalk-x.y.z-win64\ArkTalk.exe)"
End If

exePath = bestFolder & "\ArkTalk.exe"

If dryRun Then
    WScript.Echo exePath
    WScript.Quit 0
End If

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = bestFolder
shell.Run """" & exePath & """", 1, False

Sub Fail(ByVal msg)
    If dryRun Then
        WScript.Echo "ERROR: " & msg
    Else
        MsgBox msg, 16, "ArkTalk Launcher"
    End If
    WScript.Quit 1
End Sub

Function ParseVersion(ByVal name)
    ParseVersion = ""
    Dim re, m
    Set re = New RegExp
    re.Pattern = "^ArkTalk-(\d+)\.(\d+)\.(\d+)-win64$"
    re.IgnoreCase = True
    Set m = re.Execute(name)
    If m.Count = 0 Then Exit Function
    ParseVersion = Pad(CLng(m(0).SubMatches(0)), 5) & "." & _
                   Pad(CLng(m(0).SubMatches(1)), 5) & "." & _
                   Pad(CLng(m(0).SubMatches(2)), 5)
End Function

Function Pad(ByVal n, ByVal width)
    Dim s
    s = CStr(n)
    Do While Len(s) < width
        s = "0" & s
    Loop
    Pad = s
End Function
