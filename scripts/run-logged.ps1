#!/usr/bin/env pwsh
# run-logged.ps1：跑一条命令，输出全部落日志，只回显结尾与退出码。
# 用途：agent 环境里超 10 秒的 vitest / cargo / npm run check 会被截断输出，
# 走这个包装器把长输出写进临时日志，回显时只带结尾片段，省掉「重定向 + 延迟读」的来回。
#
# 用法（必须在会话内用 & 调用；pwsh -File 传不了 scriptblock）：
#   & scripts/run-logged.ps1 { npm run check }
#   & scripts/run-logged.ps1 { cargo test --manifest-path crates/executor/Cargo.toml } -Tail 80
#   & scripts/run-logged.ps1 { npx vitest run tests/jobs.test.ts } -Log C:\temp\my.log

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [scriptblock]$Command,

    # 回显日志的最后多少行，默认 40
    [int]$Tail = 40,

    # 日志路径；缺省落到 %TEMP% 下带时间戳的文件，不污染仓库
    [string]$Log = ""
)

if (-not $Log) {
    $Log = Join-Path $env:TEMP ("nexus-run-{0:yyyyMMdd-HHmmss}.log" -f (Get-Date))
}

& $Command *> $Log
$code = $LASTEXITCODE

Write-Output "log: $Log"
Get-Content $Log -Tail $Tail
Write-Output "exit=$code"
