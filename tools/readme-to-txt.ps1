# readme-to-txt.ps1 - generate the shipped docs\README.txt from ReadMe.md.
#
# ReadMe.md is the single source of truth and the only readme that is ever committed.
# This produces the plain-text copy that gets embedded in the installer, shipped in the
# zip, and dropped into the game folder. It is pure build output: it lands in obj\, is
# never checked in, and is regenerated on every build, so it cannot drift from the master.
#
# The output is deliberately pure ASCII. The V0.5-beta installer died because a UTF-8
# em-dash was read back as CP1252 and its third byte decoded to a curly quote; this script
# folds smart typography down to ASCII and then FAILS the build if anything non-ASCII
# survived, so that class of bug cannot reach a release again.

param(
  [string]$Source,
  [string]$Dest
)

$ErrorActionPreference = 'Stop'
if (-not $Source) { $Source = Join-Path (Split-Path $PSScriptRoot -Parent) 'ReadMe.md' }
if (-not $Dest)   { $Dest   = Join-Path (Split-Path $PSScriptRoot -Parent) 'obj\ReadMe.txt' }

if (-not (Test-Path $Source)) { throw "Source readme not found: $Source" }

$rule = '=' * 75
$sub  = '-' * 75

# --- typography -> ASCII -------------------------------------------------------------
function ConvertTo-Ascii([string]$s) {
  $s = $s -replace [char]0x2014, '-'        # em dash
  $s = $s -replace [char]0x2013, '-'        # en dash
  $s = $s -replace [char]0x2018, "'"        # left single quote
  $s = $s -replace [char]0x2019, "'"        # right single quote / apostrophe
  $s = $s -replace [char]0x201C, '"'        # left double quote
  $s = $s -replace [char]0x201D, '"'        # right double quote
  $s = $s -replace [char]0x2026, '...'      # ellipsis
  $s = $s -replace [char]0x00A0, ' '        # non-breaking space
  $s = $s -replace [char]0x2022, '-'        # bullet
  return $s
}

# --- inline markdown -> plain text ---------------------------------------------------
function Remove-InlineMarkdown([string]$s) {
  $s = [regex]::Replace($s, '\[([^\]]+)\]\(([^)]+)\)', '$1 ($2)')   # [text](url)
  $s = [regex]::Replace($s, '\*\*([^*]+)\*\*', '$1')                # **bold**
  $s = [regex]::Replace($s, '(?<!\w)\*([^*\s][^*]*)\*(?!\w)', '$1') # *italic*
  $s = $s -replace '`', ''                                          # `code`
  return $s
}

$out = New-Object System.Collections.Generic.List[string]
$inFence = $false

foreach ($raw in (Get-Content -LiteralPath $Source)) {
  $line = ConvertTo-Ascii $raw

  # Fenced code blocks: drop the fence markers, indent the contents, keep them verbatim
  # (they hold the exact plugins.js line a manual installer must paste).
  if ($line -match '^\s*```') { $inFence = -not $inFence; continue }
  if ($inFence) { $out.Add('   ' + $line.TrimEnd()); continue }

  if ($line -match '^#\s+(.*)$') {
    if ($out.Count -gt 0) { $out.Add('') }
    $out.Add($rule); $out.Add(' ' + (Remove-InlineMarkdown $Matches[1]).Trim()); $out.Add($rule)
    continue
  }
  if ($line -match '^##\s+(.*)$') {
    if ($out.Count -gt 0) { $out.Add('') }
    $out.Add($sub); $out.Add(' ' + (Remove-InlineMarkdown $Matches[1]).Trim()); $out.Add($sub)
    continue
  }
  if ($line -match '^###\s+(.*)$') {
    $title = (Remove-InlineMarkdown $Matches[1]).Trim()
    if ($out.Count -gt 0) { $out.Add('') }
    $out.Add(' ' + $title); $out.Add(' ' + ('-' * $title.Length))
    continue
  }

  $out.Add((Remove-InlineMarkdown $line).TrimEnd())
}

# Collapse any run of blank lines to at most two.
$clean = New-Object System.Collections.Generic.List[string]
$blanks = 0
foreach ($l in $out) {
  if ($l.Trim().Length -eq 0) { $blanks++; if ($blanks -le 2) { $clean.Add('') } }
  else { $blanks = 0; $clean.Add($l) }
}

$text = ($clean -join "`r`n").TrimEnd() + "`r`n"

# Emphasis that wraps across a line break slips past the per-line pass above, so catch
# those spans once the whole document is assembled.
$text = [regex]::Replace($text, '\*\*([\s\S]+?)\*\*', '$1')
if ($text.Contains('**')) {
  throw "Unbalanced '**' left in the generated README.txt - check the emphasis in ReadMe.md."
}

# --- the guard that the old installer needed ------------------------------------------
$bad = [regex]::Matches($text, '[^\x09\x0A\x0D\x20-\x7E]')
if ($bad.Count -gt 0) {
  $chars = ($bad | ForEach-Object { "U+{0:X4}" -f [int][char]$_.Value } | Select-Object -Unique) -join ', '
  throw "README.txt would contain non-ASCII characters ($chars). Add them to ConvertTo-Ascii in tools\readme-to-txt.ps1."
}

New-Item -ItemType Directory -Force -Path (Split-Path $Dest -Parent) | Out-Null
[System.IO.File]::WriteAllText($Dest, $text, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Generated $Dest from $(Split-Path $Source -Leaf) ($($clean.Count) lines, ASCII only)"
