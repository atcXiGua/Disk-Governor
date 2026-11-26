param(
    [Parameter(Mandatory = $true)][ValidateSet('scan', 'clean')][string]$Mode,
    [string]$Ids = ''
)

$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$L = $env:LOCALAPPDATA
$R = $env:APPDATA
$BackupRoot = 'D:\C盘清理备份'

function Get-Disks {
    $out = @()
    foreach ($x in (Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3')) {
        $out += [PSCustomObject]@{
            id    = $x.DeviceID
            total = [double]$x.Size
            free  = [double]$x.FreeSpace
        }
    }
    return $out
}

function Get-FreeC {
    $d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
    if ($d) { return [int64]$d.FreeSpace }
    return [int64]0
}

function Get-Defs {
    return @(
        [PSCustomObject]@{ id = 'updater'; name = '应用更新器残留'; risk = 'low'; sub = '01-更新器残留'
            desc = '已装完的更新包，删了最多下次更新重新下载'; path = '%LOCALAPPDATA%\*-updater\*.exe' }
        [PSCustomObject]@{ id = 'temp'; name = '临时文件'; risk = 'low'; sub = '02-临时文件'
            desc = '只清早于今天的，正在运行占用的会自动跳过'; path = '%LOCALAPPDATA%\Temp' }
        [PSCustomObject]@{ id = 'dumps'; name = '内核 / 崩溃转储'; risk = 'low'; sub = '03-转储'
            desc = '蓝屏与程序崩溃留下的内存快照，无保留价值'; path = 'LiveKernelReports · CrashDumps' }
        [PSCustomObject]@{ id = 'pipcache'; name = 'pip 缓存'; risk = 'low'; sub = '04-pip缓存'
            desc = 'Python 包下载缓存，删后重装依赖会重新下载'; path = '%LOCALAPPDATA%\pip\Cache' }
        [PSCustomObject]@{ id = 'winupdate'; name = 'Windows 更新缓存'; risk = 'admin'; sub = '05-更新缓存'
            desc = '系统更新下载残留，需管理员权限才能移动'; path = 'C:\Windows\SoftwareDistribution\Download' }
        [PSCustomObject]@{ id = 'sodamusic'; name = '汽水音乐缓存'; risk = 'mid'; sub = '06-汽水音乐'
            desc = '在线音乐缓存，关掉客户端再清，重听会自动重下'; path = '%APPDATA%\SodaMusic\LunaCacheV2' }
        [PSCustomObject]@{ id = 'chrome'; name = '浏览器缓存'; risk = 'mid'; sub = '07-浏览器缓存'
            desc = '只动缓存目录，不碰密码与登录状态；建议先关浏览器'; path = 'Chrome / Edge · Cache · GPUCache' }
        [PSCustomObject]@{ id = 'intellij'; name = 'IntelliJ 索引缓存'; risk = 'mid'; sub = '08-IntelliJ缓存'
            desc = '只清 caches / index / log，保留配置；下次开 IDE 重建索引会慢几分钟'; path = '%LOCALAPPDATA%\JetBrains\*' }
    )
}

function Get-FilesFor([string]$id) {
    $res = @()
    switch ($id) {
        'updater' {
            Get-ChildItem $L -Directory -Force | Where-Object { $_.Name -like '*updater' } | ForEach-Object {
                $res += @(Get-ChildItem $_.FullName -File -Recurse -Force | Where-Object { $_.Extension -eq '.exe' })
            }
        }
        'temp' {
            $cut = (Get-Date).Date
            $res = @(Get-ChildItem (Join-Path $L 'Temp') -Recurse -Force | Where-Object { -not $_.PSIsContainer -and $_.LastWriteTime -lt $cut })
        }
        'dumps' {
            $res += @(Get-ChildItem 'C:\Windows\LiveKernelReports' -Recurse -File -Force | Where-Object { $_.Extension -eq '.dmp' })
            $res += @(Get-ChildItem (Join-Path $L 'CrashDumps') -Recurse -File -Force)
        }
        'pipcache' {
            $res = @(Get-ChildItem (Join-Path $L 'pip\Cache') -Recurse -Force | Where-Object { -not $_.PSIsContainer })
        }
        'winupdate' {
            $res = @(Get-ChildItem 'C:\Windows\SoftwareDistribution\Download' -Recurse -File -Force)
        }
        'sodamusic' {
            $res = @(Get-ChildItem (Join-Path $R 'SodaMusic\LunaCacheV2') -Recurse -Force | Where-Object { -not $_.PSIsContainer })
        }
        'chrome' {
            $bases = @((Join-Path $L 'Google\Chrome\User Data'), (Join-Path $L 'Microsoft\Edge\User Data'))
            $names = @('Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'CacheStorage')
            foreach ($b in $bases) {
                if (-not (Test-Path $b)) { continue }
                Get-ChildItem $b -Directory -Force -Recurse -Depth 2 | Where-Object { $names -contains $_.Name } | ForEach-Object {
                    $res += @(Get-ChildItem $_.FullName -Recurse -File -Force)
                }
            }
        }
        'intellij' {
            Get-ChildItem (Join-Path $L 'JetBrains') -Directory -Force | ForEach-Object {
                foreach ($s in @('caches', 'index', 'log')) {
                    $p = Join-Path $_.FullName $s
                    if (Test-Path $p) { $res += @(Get-ChildItem $p -Recurse -File -Force) }
                }
            }
        }
    }
    return @($res | Where-Object { $_ -ne $null })
}

if ($Mode -eq 'scan') {
    $defs = Get-Defs
    $groups = @()
    foreach ($d in $defs) {
        $files = Get-FilesFor $d.id
        $bytes = [int64]0
        foreach ($f in $files) { $bytes += [int64]$f.Length }
        $groups += [PSCustomObject]@{
            id    = $d.id
            name  = $d.name
            risk  = $d.risk
            desc  = $d.desc
            path  = $d.path
            files = $files.Count
            bytes = $bytes
        }
    }
    $out = [PSCustomObject]@{
        ok     = $true
        disks  = @(Get-Disks)
        groups = @($groups)
        backup = $BackupRoot
        when   = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    }
    [Console]::Out.Write(($out | ConvertTo-Json -Depth 6 -Compress))
    return
}

if ($Mode -eq 'clean') {
    $ids = @($Ids -split ',' | Where-Object { $_ -ne '' })
    if ($ids.Count -eq 0) {
        [Console]::Out.Write('{"ok":false,"error":"没有选择任何清理项"}')
        return
    }
    $defs = Get-Defs
    $before = Get-FreeC
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $dst = Join-Path $BackupRoot $stamp
    $moved = 0
    $bytes = [int64]0
    $skipped = @()
    $manifest = @()

    foreach ($id in $ids) {
        $def = $defs | Where-Object { $_.id -eq $id } | Select-Object -First 1
        if (-not $def) { continue }
        foreach ($f in (Get-FilesFor $id)) {
            $full = $f.FullName
            $rel = $full -replace '^[A-Za-z]:\\', ''
            $target = Join-Path (Join-Path $dst $def.sub) $rel
            $dir = Split-Path $target -Parent
            if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
            Move-Item -LiteralPath $full -Destination $target -Force -ErrorAction SilentlyContinue
            if ((Test-Path -LiteralPath $target) -and (-not (Test-Path -LiteralPath $full))) {
                $moved++
                $bytes += [int64]$f.Length
                $manifest += [PSCustomObject]@{ src = $full; dst = $target; bytes = [int64]$f.Length }
            }
            else {
                $skipped += $full
            }
        }
    }

    if ($manifest.Count -gt 0) {
        if (-not (Test-Path -LiteralPath $dst)) { New-Item -ItemType Directory -Path $dst -Force | Out-Null }
        $manifest | Export-Csv (Join-Path $dst '_移动清单.csv') -NoTypeInformation -Encoding UTF8
    }

    $after = Get-FreeC
    $out = [PSCustomObject]@{
        ok          = $true
        before      = $before
        after       = $after
        freed       = ($after - $before)
        moved       = $moved
        bytes       = $bytes
        skipped     = $skipped.Count
        skippedList = @($skipped | Select-Object -First 10)
        backup      = $dst
        when        = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        ids         = @($ids)
    }
    [Console]::Out.Write(($out | ConvertTo-Json -Depth 6 -Compress))
    return
}
