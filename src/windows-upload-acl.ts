// Runs inside Git Bash on Windows. Git Bash's chmod/umask do not set NTFS ACLs.
function powershell(script: string): string {
    const encoded = Buffer.from(`$ErrorActionPreference = 'Stop';\n${script}`, "utf16le").toString("base64");
    return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

export const windowsCreatePrivateStage = powershell(`
$path = $env:FILAXIS_UPLOAD_STAGE
$parent = [IO.Path]::GetDirectoryName($path)
if (-not [IO.Directory]::Exists($parent) -or (Test-Path -LiteralPath $path)) {
    throw 'Invalid upload staging directory'
}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object Security.AccessControl.FileSystemAccessRule(
    $sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
[void][IO.Directory]::CreateDirectory($path, $acl)
$actual = [IO.Directory]::GetAccessControl($path)
$rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if (([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -or
    -not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]) -ne $sid -or
    $rules.Count -ne 1 -or $rules[0].IdentityReference -ne $sid -or
    $rules[0].FileSystemRights -ne $rule.FileSystemRights -or $rules[0].AccessControlType -ne $rule.AccessControlType -or
    $rules[0].InheritanceFlags -ne $rule.InheritanceFlags -or $rules[0].PropagationFlags -ne $rule.PropagationFlags) {
    throw 'Upload staging ACL could not be verified'
}
`);

export const windowsPlaceVerifiedPayload = powershell(`
$source = $env:FILAXIS_UPLOAD_SOURCE
$target = $env:FILAXIS_UPLOAD_TARGET
if ([IO.File]::Exists($target)) {
    $access = [Security.AccessControl.AccessControlSections]::Access
    $before = [IO.File]::GetAccessControl($target, $access).GetSecurityDescriptorSddlForm($access)
    [IO.File]::Replace($source, $target, [NullString]::Value)
    # ReplaceFile merges ACLs. With a private source directory, inherited entries may differ.
    $after = [IO.File]::GetAccessControl($target, $access)
    if ($after.GetSecurityDescriptorSddlForm($access) -ne $before) {
        $after.SetSecurityDescriptorSddlForm($before, $access)
        [IO.File]::SetAccessControl($target, $after)
        if ([IO.File]::GetAccessControl($target, $access).GetSecurityDescriptorSddlForm($access) -ne $before) {
            throw 'Upload was published but the original DACL could not be restored'
        }
    }
} else {
    # Publish the still-private file, then apply the destination directory's inherited ACL.
    [IO.File]::Move($source, $target)
    & icacls.exe $target /reset | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Upload was published but its inherited ACL could not be applied'
    }
}
`);

export const windowsPlaceExclusivePayload = powershell(`
$source = $env:FILAXIS_UPLOAD_SOURCE
$target = $env:FILAXIS_UPLOAD_TARGET
if (Test-Path -LiteralPath $target) {
    Write-Output 'FX_ALREADY_EXISTS'
    exit 1
}
try {
    [IO.File]::Move($source, $target)
} catch [IO.IOException] {
    if (Test-Path -LiteralPath $target) {
        Write-Output 'FX_ALREADY_EXISTS'
        exit 1
    }
    throw
}
& icacls.exe $target /reset | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'Upload was published but its inherited ACL could not be applied'
}
`);
