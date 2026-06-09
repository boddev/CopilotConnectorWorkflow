<#
.SYNOPSIS
  Phase 7 signing — sign a Ccw.UI MSIX produced by build-msix.ps1.

.DESCRIPTION
  Two modes:

  - SelfSigned (default): generate / reuse a developer self-signed code
    signing certificate, optionally trust it in LocalMachine\TrustedPeople,
    patch the MSIX Identity Publisher to match the cert Subject, repack,
    sign, and optionally verify by installing via Add-AppxPackage.

  - AzureTrustedSigning: defer signing to the Microsoft Trusted Signing
    service via `signtool /dlib Azure.CodeSigning.Dlib.dll /dmdf
    metadata.json`. The Publisher is supplied via -SigningPublisher
    (CI passes the canonical subject of the configured Trusted Signing
    certificate profile).

  Adapted from the EvalToolkit sibling (eval-ui-winui3 slice 34); both
  reviewer BLOCKERs/IMPORTANTs from GPT-5.5 are folded in:
    - production signing via signtool + dlib (NOT Sign CLI).
    - Publisher derived from the actual cert (X509Certificate2.Subject
      for self-signed; -SigningPublisher param for Trusted Signing). XML
      DOM patch, not regex. Asserted both pre-sign and post-sign.
    - explicit manifest patch in the unsigned MSIX (do not rely on
      MSBuild auto-substituting Publisher from PackageCertificateThumbprint).
    - no `/nv` on makeappx pack so validation runs.
    - trust dev cert in LocalMachine\TrustedPeople (admin required).
    - timestamp via http://timestamp.acs.microsoft.com for prod.
    - targeted error messages for known Add-AppxPackage HRESULTs.

.PARAMETER MsixPath
  Path to the unsigned .msix produced by build-msix.ps1.

.PARAMETER Mode
  SelfSigned | AzureTrustedSigning. Default: SelfSigned.

.PARAMETER DevCertPath
  Path to dev PFX. Default: %LOCALAPPDATA%\CcwUI\dev-signing\CcwUI.Dev.pfx

.PARAMETER DevCertSubject
  Subject for newly-created dev certs. Default: CN=CcwUI.Dev

.PARAMETER DevCertValidYears
  Validity period for newly-created dev certs. Default: 2.

.PARAMETER Force
  Regenerate the dev PFX even if it already exists.

.PARAMETER TrustDevCert
  Import the dev cert (public part only) into Cert:\LocalMachine\TrustedPeople
  so Add-AppxPackage accepts MSIXes signed by it. Requires elevation.

.PARAMETER SigningPublisher
  Canonical certificate Subject the manifest Publisher must match. For
  Mode=SelfSigned this is auto-derived from the cert; for Mode=AzureTrustedSigning
  it MUST be supplied explicitly.

.PARAMETER TrustedSigningDlibPath
  Path to Azure.CodeSigning.Dlib.dll for Trusted Signing. Auto-discovers via
  $env:TRUSTED_SIGNING_DLIB or the NuGet packages
  Microsoft.ArtifactSigning.Client (current) / Microsoft.Trusted.Signing.Client
  (legacy). x64 variant is selected to match the x64 signtool.exe.

.PARAMETER TrustedSigningMetadataPath
  Path to metadata.json with Endpoint / CodeSigningAccountName /
  CertificateProfileName for /dmdf.

.PARAMETER TimestampUrl
  Timestamp URL. Defaults to http://timestamp.acs.microsoft.com.

.PARAMETER VerifyInstall
  After signing, Add-AppxPackage the result + Get-AppxPackage to confirm.

.PARAMETER OutputPath
  Where to write the signed MSIX. Defaults to <MsixPath dir>\signed\<basename>.msix

.EXAMPLE
  pwsh sign-msix.ps1 -MsixPath .\dist\x64\CopilotConnectorWorkflow.WinUI_0.1.0.0_x64.msix `
        -Mode SelfSigned -TrustDevCert -VerifyInstall

.EXAMPLE
  pwsh sign-msix.ps1 -MsixPath .\dist\x64\CopilotConnectorWorkflow.WinUI_0.1.0.0_x64.msix `
        -Mode AzureTrustedSigning `
        -SigningPublisher 'CN=Contoso, O=Contoso Corp, L=Redmond, S=WA, C=US' `
        -TrustedSigningMetadataPath .\azure-signing\metadata.json
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$MsixPath,
    [ValidateSet('SelfSigned','AzureTrustedSigning')] [string]$Mode = 'SelfSigned',

    [string]$DevCertPath = (Join-Path $env:LOCALAPPDATA 'CcwUI\dev-signing\CcwUI.Dev.pfx'),
    [string]$DevCertSubject = 'CN=CcwUI.Dev',
    [int]$DevCertValidYears = 2,
    [switch]$Force,
    [switch]$TrustDevCert,

    [string]$SigningPublisher,
    [string]$TrustedSigningDlibPath,
    [string]$TrustedSigningMetadataPath,

    [string]$TimestampUrl = 'http://timestamp.acs.microsoft.com',

    [switch]$VerifyInstall,
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# --------------------------------------------------------------------------
# Tool discovery
# --------------------------------------------------------------------------

function Get-LatestSdkTool {
    param([Parameter(Mandatory)] [string]$ToolName)

    $candidates = @(
        "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
        "$env:ProgramFiles\Windows Kits\10\bin"
    ) | Where-Object { Test-Path $_ }

    $found = foreach ($root in $candidates) {
        Get-ChildItem -Path $root -Filter $ToolName -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -like '*\x64\*' }
    }

    $latest = $found | Sort-Object {
        $verSegment = Split-Path (Split-Path (Split-Path $_.FullName -Parent) -Parent) -Leaf
        try { [version]$verSegment } catch { [version]'0.0' }
    } -Descending | Select-Object -First 1
    if (-not $latest) {
        throw "Phase 7 signing prerequisite missing: '$ToolName' not found under any installed Windows 10 SDK (searched $($candidates -join ', ')). Install the Windows 10 SDK 10.0.19041 or newer."
    }
    return $latest.FullName
}

# --------------------------------------------------------------------------
# Self-signed cert lifecycle
# --------------------------------------------------------------------------

function New-DevCertificate {
    param(
        [Parameter(Mandatory)] [string]$Subject,
        [Parameter(Mandatory)] [string]$PfxPath,
        [Parameter(Mandatory)] [int]$ValidYears
    )

    $dir = Split-Path $PfxPath -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

    Write-Host "  Generating self-signed code-signing cert: $Subject" -ForegroundColor Cyan
    $cert = New-SelfSignedCertificate `
        -Subject $Subject `
        -Type CodeSigningCert `
        -KeyUsage DigitalSignature `
        -KeyAlgorithm RSA `
        -KeyLength 2048 `
        -CertStoreLocation 'Cert:\CurrentUser\My' `
        -NotAfter (Get-Date).AddYears($ValidYears) `
        -TextExtension @(
            '2.5.29.37={text}1.3.6.1.5.5.7.3.3',
            '2.5.29.19={text}'
        )

    # Random 32-byte password; persisted alongside PFX as DPAPI-encrypted
    # text. DPAPI binds the ciphertext to the current user + machine, so
    # signtool can rehydrate it later without re-prompting, but it is not
    # readable by other users on the box.
    $pwdBytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($pwdBytes)
    $pwdString = [Convert]::ToBase64String($pwdBytes)
    $pwd = ConvertTo-SecureString $pwdString -AsPlainText -Force

    $null = Export-PfxCertificate -Cert $cert -FilePath $PfxPath -Password $pwd
    $pwdPath = "$PfxPath.password.txt"
    $dpapiBlob = ConvertFrom-SecureString -SecureString $pwd
    Set-Content -Path $pwdPath -Value $dpapiBlob -NoNewline -Encoding ascii

    foreach ($p in @($PfxPath, $pwdPath)) {
        $acl = Get-Acl $p
        $acl.SetAccessRuleProtection($true, $false)
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            [System.Security.Principal.WindowsIdentity]::GetCurrent().User,
            'FullControl', 'Allow')
        $acl.SetAccessRule($rule)
        Set-Acl -Path $p -AclObject $acl
    }

    $null = Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)" -Force

    Write-Host "    PFX:      $PfxPath"
    Write-Host "    Password: $pwdPath (chmod 0600)"
    Write-Host "    Subject:  $($cert.Subject)"
    Write-Host "    Thumb:    $($cert.Thumbprint)"
    Write-Host "    Expires:  $($cert.NotAfter.ToString('u'))"

    return [PSCustomObject]@{
        PfxPath = $PfxPath
        Password = $pwd
        PasswordPlain = $pwdString
        Subject = $cert.Subject
        Thumbprint = $cert.Thumbprint
    }
}

function Get-DevCertificate {
    param([Parameter(Mandatory)] [string]$PfxPath)

    $pwdPath = "$PfxPath.password.txt"
    if (-not (Test-Path $pwdPath)) {
        throw "Phase 7 signing: PFX exists at '$PfxPath' but companion password file '$pwdPath' is missing. Re-run with -Force to regenerate, or restore the password file from a secure backup."
    }
    $raw = (Get-Content $pwdPath -Raw).Trim()

    $pwd = $null
    try {
        $pwd = ConvertTo-SecureString $raw -ErrorAction Stop
    } catch {
        # Opus Phase 7 review IMPORTANT 5: NO silent plaintext fallback.
        # An attacker who can write to the password file (the ACL is only
        # set once at creation; later loosening would silently re-enable
        # this path) could substitute their own PFX + plaintext password
        # and the signer cert would change silently. Hard-fail with
        # actionable guidance.
        throw "Phase 7 signing: dev cert password at '$pwdPath' is not a valid DPAPI blob for the current user/machine, so it cannot be safely rehydrated. Re-run sign-msix.ps1 with -Force to regenerate the dev PFX (the new password will be DPAPI-bound to this user). Underlying error: $($_.Exception.Message)"
    }
    $pwdString = [System.Net.NetworkCredential]::new('', $pwd).Password

    $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(
        $PfxPath, $pwd,
        [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable)

    return [PSCustomObject]@{
        PfxPath = $PfxPath
        Password = $pwd
        PasswordPlain = $pwdString
        Subject = $cert.Subject
        Thumbprint = $cert.Thumbprint
    }
}

function Install-DevCertificateTrust {
    param(
        [Parameter(Mandatory)] [string]$PfxPath,
        [Parameter(Mandatory)] [SecureString]$Password
    )

    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        throw "Phase 7 signing: -TrustDevCert requires elevation (writing to Cert:\LocalMachine\TrustedPeople). Re-run pwsh from an elevated terminal."
    }

    $fullCert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($PfxPath, $Password)
    $publicCert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(@(,$fullCert.RawData))

    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store(
        [System.Security.Cryptography.X509Certificates.StoreName]::TrustedPeople,
        [System.Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine)
    $store.Open('ReadWrite')
    try {
        $existing = $store.Certificates | Where-Object Thumbprint -eq $publicCert.Thumbprint
        if ($existing) {
            Write-Host "  Dev cert already trusted at LocalMachine\TrustedPeople (thumb $($publicCert.Thumbprint))." -ForegroundColor DarkGray
        } else {
            $store.Add($publicCert)
            Write-Host "  Dev cert trusted at LocalMachine\TrustedPeople (thumb $($publicCert.Thumbprint))." -ForegroundColor Green
        }
    } finally {
        $store.Close()
    }
}

# --------------------------------------------------------------------------
# MSIX manifest patching (XML DOM, not regex)
# --------------------------------------------------------------------------

function Set-MsixIdentityPublisher {
    param(
        [Parameter(Mandatory)] [string]$UnsignedMsixPath,
        [Parameter(Mandatory)] [string]$Publisher,
        [Parameter(Mandatory)] [string]$OutputMsixPath,
        [Parameter(Mandatory)] [string]$MakeAppx
    )

    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "ccw-sign-$([guid]::NewGuid().ToString('N'))"
    $unpackDir = Join-Path $tempRoot 'unpack'
    try {
        New-Item -ItemType Directory -Force -Path $unpackDir | Out-Null

        Write-Host "  Unpacking MSIX for manifest patch..." -ForegroundColor DarkGray
        & $MakeAppx unpack /p $UnsignedMsixPath /d $unpackDir /nv | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Phase 7 signing: makeappx unpack failed for '$UnsignedMsixPath' (exit $LASTEXITCODE)."
        }

        $manifestPath = Join-Path $unpackDir 'AppxManifest.xml'
        if (-not (Test-Path $manifestPath)) {
            throw "Phase 7 signing: unpacked MSIX has no AppxManifest.xml at '$manifestPath'."
        }

        [xml]$xml = Get-Content $manifestPath -Raw
        $identity = $xml.Package.Identity
        $oldPublisher = $identity.Publisher
        $identity.SetAttribute('Publisher', $Publisher)
        $xml.Save($manifestPath)

        Write-Host "  Patched Identity Publisher: '$oldPublisher' -> '$Publisher'" -ForegroundColor Cyan

        [xml]$verify = Get-Content $manifestPath -Raw
        if ($verify.Package.Identity.Publisher -ne $Publisher) {
            throw "Phase 7 signing: post-patch verify failed. Expected Publisher='$Publisher', got '$($verify.Package.Identity.Publisher)'."
        }

        $outputDir = Split-Path $OutputMsixPath -Parent
        if (-not (Test-Path $outputDir)) { New-Item -ItemType Directory -Force -Path $outputDir | Out-Null }
        if (Test-Path $OutputMsixPath) { Remove-Item $OutputMsixPath -Force }

        Write-Host "  Repacking patched MSIX..." -ForegroundColor DarkGray
        & $MakeAppx pack /d $unpackDir /p $OutputMsixPath | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Phase 7 signing: makeappx pack failed for '$OutputMsixPath' (exit $LASTEXITCODE)."
        }
        if (-not (Test-Path $OutputMsixPath)) {
            throw "Phase 7 signing: makeappx pack reported success but '$OutputMsixPath' does not exist."
        }
    } finally {
        Remove-Item -Recurse -Force $tempRoot -ErrorAction SilentlyContinue
    }
}

# --------------------------------------------------------------------------
# signtool wrappers
# --------------------------------------------------------------------------

function Invoke-SignSelfSigned {
    param(
        [Parameter(Mandatory)] [string]$MsixPath,
        [Parameter(Mandatory)] [string]$PfxPath,
        [Parameter(Mandatory)] [string]$PasswordPlain,
        [Parameter(Mandatory)] [string]$SignTool,
        [Parameter(Mandatory)] [string]$TimestampUrl
    )

    Write-Host "  signtool sign /fd SHA256 /td SHA256 /tr $TimestampUrl ..." -ForegroundColor DarkGray
    & $SignTool sign /v /fd SHA256 /td SHA256 /tr $TimestampUrl /f $PfxPath /p $PasswordPlain $MsixPath
    if ($LASTEXITCODE -ne 0) {
        throw "Phase 7 signing: signtool sign (self-signed) failed for '$MsixPath' (exit $LASTEXITCODE)."
    }
}

function Invoke-SignAzureTrustedSigning {
    param(
        [Parameter(Mandatory)] [string]$MsixPath,
        [Parameter(Mandatory)] [string]$DlibPath,
        [Parameter(Mandatory)] [string]$MetadataPath,
        [Parameter(Mandatory)] [string]$SignTool,
        [Parameter(Mandatory)] [string]$TimestampUrl
    )

    if (-not (Test-Path $DlibPath)) {
        throw "Phase 7 signing: Azure.CodeSigning.Dlib.dll not found at '$DlibPath'. Install Microsoft.ArtifactSigning.Client (current) or Microsoft.Trusted.Signing.Client (legacy) NuGet package and pass -TrustedSigningDlibPath, or set `$env:TRUSTED_SIGNING_DLIB."
    }
    if (-not (Test-Path $MetadataPath)) {
        throw "Phase 7 signing: Trusted Signing metadata.json not found at '$MetadataPath'. Copy azure-signing\metadata.template.json and fill in Endpoint / CodeSigningAccountName / CertificateProfileName."
    }

    Write-Host "  signtool sign /dlib $DlibPath /dmdf $MetadataPath ..." -ForegroundColor DarkGray
    & $SignTool sign /v /debug /fd SHA256 /td SHA256 /tr $TimestampUrl /dlib $DlibPath /dmdf $MetadataPath $MsixPath
    if ($LASTEXITCODE -ne 0) {
        throw "Phase 7 signing: signtool sign (Trusted Signing) failed for '$MsixPath' (exit $LASTEXITCODE). Confirm Azure credentials (DefaultAzureCredential chain), profile permissions, and that the Trusted Signing endpoint is reachable."
    }
}

function Test-SignedMsix {
    param(
        [Parameter(Mandatory)] [string]$MsixPath,
        [Parameter(Mandatory)] [string]$SignTool,
        [Parameter(Mandatory)] [string]$MakeAppx,
        [Parameter(Mandatory)] [string]$ExpectedPublisher,
        [switch]$AllowUntrustedRoot
    )

    $sig = Get-AuthenticodeSignature $MsixPath
    if (-not $sig.SignerCertificate) {
        throw "Phase 7 signing: Get-AuthenticodeSignature reports no signer certificate. The signing step did not actually attach a signature."
    }
    $signerSubject = $sig.SignerCertificate.Subject
    if ($signerSubject -ne $ExpectedPublisher) {
        throw "Phase 7 signing: signer cert Subject='$signerSubject' does not equal expected Publisher='$ExpectedPublisher'. Add-AppxPackage will reject this MSIX with a publisher-mismatch error."
    }

    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) "ccw-verify-$([guid]::NewGuid().ToString('N'))"
    try {
        & $MakeAppx unpack /p $MsixPath /d $tmp /nv | Out-Null
        [xml]$mf = Get-Content (Join-Path $tmp 'AppxManifest.xml') -Raw
        if ($mf.Package.Identity.Publisher -ne $ExpectedPublisher) {
            throw "Phase 7 signing: signed MSIX Identity Publisher='$($mf.Package.Identity.Publisher)' does not match expected '$ExpectedPublisher'."
        }
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }

    Write-Host "  signtool verify /pa /v ..." -ForegroundColor DarkGray
    $verifyOutput = & $SignTool verify /pa /v $MsixPath 2>&1
    if ($LASTEXITCODE -ne 0) {
        if ($AllowUntrustedRoot) {
            Write-Host "    NOTE: chain verify failed (expected — root not trusted). Re-run with -TrustDevCert + elevated terminal to make Add-AppxPackage accept this MSIX." -ForegroundColor DarkYellow
            Write-Host "    Structural signature + publisher match: OK." -ForegroundColor Green
            return
        }
        Write-Host $verifyOutput
        throw "Phase 7 signing: signtool verify /pa failed for '$MsixPath'. Root cert is probably not trusted on this machine (try -TrustDevCert for SelfSigned mode)."
    }

    if ($sig.Status -ne 'Valid') {
        throw "Phase 7 signing: Get-AuthenticodeSignature reports Status='$($sig.Status)' (expected Valid)."
    }
    Write-Host "  Signature: Valid; Signer: $signerSubject" -ForegroundColor Green
}

function Invoke-VerifyInstall {
    param([Parameter(Mandatory)] [string]$MsixPath)

    Write-Host "  Add-AppxPackage -Path '$MsixPath'..." -ForegroundColor DarkGray
    try {
        Add-AppxPackage -Path $MsixPath -ForceApplicationShutdown -ErrorAction Stop
    } catch {
        $hrPattern = '0x[0-9A-Fa-f]{8}'
        $hr = ([regex]::Match($_.Exception.Message, $hrPattern)).Value
        $guidance = switch -Regex ($hr) {
            '0x800B0109' { 'Root certificate not trusted on this machine. For self-signed dev: re-run sign-msix.ps1 with -TrustDevCert from an elevated terminal. For Trusted Signing: the Microsoft Trusted Signing root chain should already be trusted in Windows — investigate cert chain via signtool verify /pa /v.' }
            '0x800B0100' { 'Package is not signed (or signature was stripped). Re-run sign-msix.ps1 to attach a signature.' }
            '0x80073CF0' { 'Package open / validation failure. One common cause is signature/publisher mismatch (manifest Publisher does not equal signer cert Subject); other causes include a malformed .msix or corrupted block map. Confirm signtool verify /pa /v on the package, and re-sign after running sign-msix.ps1 with the correct -SigningPublisher.' }
            '0x80073CF3' { 'Package dependencies missing — the WindowsAppSDK / .NET runtime packages bundled inside the MSIX should make this impossible. Inspect with: Add-AppxPackage -Path X -Verbose.' }
            '0x80073CFB' { 'Package already installed (or conflicting version present). Try: Get-AppxPackage CopilotConnectorWorkflow.WinUI | Remove-AppxPackage, then re-install.' }
            '0x80073CFD' { 'Architecture mismatch — this MSIX targets a different ProcessorArchitecture than the current OS (e.g., trying to install arm64 on x64 host).' }
            '0x80073D02' { 'Package resources in use — a CcwUI process is running. Close all instances and retry.' }
            '0x80073D06' { 'A higher version of CopilotConnectorWorkflow.WinUI is already installed. Increment Identity Version in Package.appxmanifest, or remove the installed package first.' }
            default      { 'Inspect Get-AppPackageLog -ActivityID (from event log Microsoft-Windows-AppXDeploymentServer/Operational) for the deployment failure details.' }
        }
        throw "Phase 7 signing: Add-AppxPackage failed (HRESULT $hr). Guidance: $guidance Underlying error: $($_.Exception.Message)"
    }

    $pkg = Get-AppxPackage -Name 'CopilotConnectorWorkflow.WinUI' | Select-Object -First 1
    if (-not $pkg) {
        throw "Phase 7 signing: Add-AppxPackage reported success but Get-AppxPackage cannot find CopilotConnectorWorkflow.WinUI."
    }
    Write-Host "  Installed: $($pkg.PackageFullName)" -ForegroundColor Green
    Write-Host "    Publisher: $($pkg.Publisher)"
    Write-Host "    InstallLocation: $($pkg.InstallLocation)"
}

# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

if (-not (Test-Path $MsixPath)) {
    throw "Phase 7 signing: input MSIX not found at '$MsixPath'."
}
$MsixPath = (Resolve-Path $MsixPath).Path

if (-not $OutputPath) {
    $parentDir = Split-Path $MsixPath -Parent
    if ((Split-Path $parentDir -Leaf) -ieq 'signed') {
        $signedDir = $parentDir
    }
    else {
        $signedDir = Join-Path $parentDir 'signed'
    }
    $OutputPath = Join-Path $signedDir ([System.IO.Path]::GetFileName($MsixPath))
}
if (-not (Test-Path (Split-Path $OutputPath -Parent))) {
    New-Item -ItemType Directory -Force -Path (Split-Path $OutputPath -Parent) | Out-Null
}

Write-Host ''
Write-Host '=== Phase 7: Sign MSIX ===' -ForegroundColor Yellow
Write-Host "  Input:  $MsixPath"
Write-Host "  Output: $OutputPath"
Write-Host "  Mode:   $Mode"

$signTool = Get-LatestSdkTool -ToolName 'signtool.exe'
$makeAppx = Get-LatestSdkTool -ToolName 'makeappx.exe'
Write-Host "  signtool: $signTool" -ForegroundColor DarkGray
Write-Host "  makeappx: $makeAppx" -ForegroundColor DarkGray
Write-Host ''

# Write to a staging .msix first, then atomically replace OutputPath only
# after signing + verification succeed. Avoids leaving a Publisher-patched-
# but-unsigned MSIX at OutputPath when signtool fails mid-flight.
$stagingPath = "$OutputPath.staging.msix"
if (Test-Path $stagingPath) { Remove-Item -LiteralPath $stagingPath -Force }

try {
switch ($Mode) {
    'SelfSigned' {
        Write-Host '--- 1/4 Cert lifecycle ---' -ForegroundColor Yellow
        $certInfo = $null
        if ($Force -or -not (Test-Path $DevCertPath)) {
            $certInfo = New-DevCertificate -Subject $DevCertSubject -PfxPath $DevCertPath -ValidYears $DevCertValidYears
        } else {
            Write-Host "  Reusing existing dev cert: $DevCertPath" -ForegroundColor Cyan
            $certInfo = Get-DevCertificate -PfxPath $DevCertPath
            Write-Host "    Subject: $($certInfo.Subject)"
            Write-Host "    Thumb:   $($certInfo.Thumbprint)"
        }

        if ($TrustDevCert) {
            Install-DevCertificateTrust -PfxPath $certInfo.PfxPath -Password $certInfo.Password
        } else {
            Write-Host "  -TrustDevCert not specified; signed MSIX will fail Add-AppxPackage with 0x800B0109 unless cert is already trusted." -ForegroundColor DarkYellow
        }

        $publisher = $certInfo.Subject

        Write-Host ''
        Write-Host '--- 2/4 Patch + repack ---' -ForegroundColor Yellow
        Set-MsixIdentityPublisher -UnsignedMsixPath $MsixPath -Publisher $publisher -OutputMsixPath $stagingPath -MakeAppx $makeAppx

        Write-Host ''
        Write-Host '--- 3/4 Sign ---' -ForegroundColor Yellow
        Invoke-SignSelfSigned -MsixPath $stagingPath -PfxPath $certInfo.PfxPath -PasswordPlain $certInfo.PasswordPlain -SignTool $signTool -TimestampUrl $TimestampUrl

        Write-Host ''
        Write-Host '--- 4/4 Verify ---' -ForegroundColor Yellow
        Test-SignedMsix -MsixPath $stagingPath -SignTool $signTool -MakeAppx $makeAppx -ExpectedPublisher $publisher -AllowUntrustedRoot:(-not $TrustDevCert)
    }

    'AzureTrustedSigning' {
        if (-not $SigningPublisher) {
            throw "Phase 7 signing: -SigningPublisher is required for Mode=AzureTrustedSigning. Supply the canonical Subject DN of your Trusted Signing certificate profile, e.g. 'CN=Contoso, O=Contoso Corp, L=Redmond, S=WA, C=US'."
        }

        $dlibPath = $TrustedSigningDlibPath
        if (-not $dlibPath -and $env:TRUSTED_SIGNING_DLIB) { $dlibPath = $env:TRUSTED_SIGNING_DLIB }
        if (-not $dlibPath) {
            $nugetCandidates = @(
                "$env:USERPROFILE\.nuget\packages\microsoft.artifactsigning.client",
                "$env:NUGET_PACKAGES\microsoft.artifactsigning.client",
                "$env:USERPROFILE\.nuget\packages\microsoft.trusted.signing.client",
                "$env:NUGET_PACKAGES\microsoft.trusted.signing.client"
            ) | Where-Object { $_ -and (Test-Path $_) }
            foreach ($root in $nugetCandidates) {
                $candidate = Get-ChildItem -Path $root -Recurse -Filter 'Azure.CodeSigning.Dlib.dll' -ErrorAction SilentlyContinue |
                    Where-Object { $_.FullName -match '\\x64\\' } |
                    Sort-Object FullName -Descending | Select-Object -First 1
                if ($candidate) { $dlibPath = $candidate.FullName; break }
            }
        }
        if (-not $dlibPath) {
            throw "Phase 7 signing: cannot locate Azure.CodeSigning.Dlib.dll (x64). Pass -TrustedSigningDlibPath, set `$env:TRUSTED_SIGNING_DLIB, or install one of: 'nuget install Microsoft.ArtifactSigning.Client -ExcludeVersion' (current) or 'dotnet add package Microsoft.Trusted.Signing.Client' (legacy fallback)."
        }

        if (-not $TrustedSigningMetadataPath) {
            $TrustedSigningMetadataPath = Join-Path (Split-Path $PSCommandPath -Parent) 'azure-signing\metadata.json'
        }

        Write-Host '--- 1/3 Patch + repack ---' -ForegroundColor Yellow
        Set-MsixIdentityPublisher -UnsignedMsixPath $MsixPath -Publisher $SigningPublisher -OutputMsixPath $stagingPath -MakeAppx $makeAppx

        Write-Host ''
        Write-Host '--- 2/3 Sign (Azure Trusted Signing) ---' -ForegroundColor Yellow
        Invoke-SignAzureTrustedSigning -MsixPath $stagingPath -DlibPath $dlibPath -MetadataPath $TrustedSigningMetadataPath -SignTool $signTool -TimestampUrl $TimestampUrl

        Write-Host ''
        Write-Host '--- 3/3 Verify ---' -ForegroundColor Yellow
        Test-SignedMsix -MsixPath $stagingPath -SignTool $signTool -MakeAppx $makeAppx -ExpectedPublisher $SigningPublisher
    }
}

if (Test-Path $OutputPath) { Remove-Item -LiteralPath $OutputPath -Force }
Move-Item -LiteralPath $stagingPath -Destination $OutputPath
}
catch {
    if (Test-Path $stagingPath) { Remove-Item -LiteralPath $stagingPath -Force -ErrorAction SilentlyContinue }
    throw
}

if ($VerifyInstall) {
    Write-Host ''
    Write-Host '--- bonus: install + verify ---' -ForegroundColor Yellow
    Invoke-VerifyInstall -MsixPath $OutputPath
}

Write-Host ''
Write-Host 'Signed MSIX summary' -ForegroundColor Green
$item = Get-Item $OutputPath
$hash = (Get-FileHash $OutputPath -Algorithm SHA256).Hash
[PSCustomObject]@{
    Path = $OutputPath
    SizeMB = [math]::Round($item.Length / 1MB, 2)
    SHA256 = $hash
} | Format-List
