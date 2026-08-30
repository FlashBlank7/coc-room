param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Set", "Status", "Delete")]
    [string]$Action
)

$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
    throw "DeepSeek credential management currently requires Windows Credential Manager."
}

if (-not ("CocRoom.NativeCredential" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace CocRoom {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct Credential {
        public UInt32 Flags;
        public UInt32 Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public UInt32 CredentialBlobSize;
        public IntPtr CredentialBlob;
        public UInt32 Persist;
        public UInt32 AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    public static class NativeCredential {
        [DllImport("Advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CredWrite(ref Credential credential, UInt32 flags);

        [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);

        [DllImport("Advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);

        [DllImport("Advapi32.dll", EntryPoint = "CredFree", SetLastError = false)]
        public static extern void CredFree(IntPtr credential);
    }
}
"@
}

$credentialTypeGeneric = 1
$credentialPersistEnterprise = 3
$notFound = 1168
$service = "org.coc-room.desktop"
$account = "deepseek-api-key"
# keyring-rs 3.x Windows-native default mapping is: user + "." + service.
$target = "$account.$service"

switch ($Action) {
    "Status" {
        $pointer = [IntPtr]::Zero
        $credential = $null
        if ([CocRoom.NativeCredential]::CredRead($target, $credentialTypeGeneric, 0, [ref]$pointer)) {
            try {
                $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][CocRoom.Credential])
                if ($credential.UserName -eq $account -and $credential.CredentialBlobSize -gt 0) {
                    Write-Output "DeepSeek API Key is stored in Windows Credential Manager."
                    exit 0
                }
            }
            finally {
                if ($null -ne $credential -and $credential.CredentialBlob -ne [IntPtr]::Zero -and $credential.CredentialBlobSize -gt 0) {
                    $zeros = New-Object byte[] $credential.CredentialBlobSize
                    [Runtime.InteropServices.Marshal]::Copy($zeros, 0, $credential.CredentialBlob, $zeros.Length)
                }
                [CocRoom.NativeCredential]::CredFree($pointer)
            }
        }
        elseif ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne $notFound) {
            throw "Unable to read Windows Credential Manager."
        }
        Write-Output "DeepSeek API Key is not stored."
        exit 1
    }
    "Delete" {
        if ([CocRoom.NativeCredential]::CredDelete($target, $credentialTypeGeneric, 0)) {
            Write-Output "DeepSeek API Key removed from Windows Credential Manager."
            exit 0
        }
        $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($code -eq $notFound) {
            Write-Output "DeepSeek API Key was already absent."
            exit 0
        }
        throw "Unable to delete the DeepSeek API Key from Windows Credential Manager."
    }
    "Set" {
        $secret = Read-Host "DeepSeek API Key (input is hidden)" -AsSecureString
        if ($secret.Length -lt 1 -or $secret.Length -gt 512) {
            throw "DeepSeek API Key length must be between 1 and 512 characters."
        }
        $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($secret)
        try {
            $credential = New-Object CocRoom.Credential
            $credential.Flags = 0
            $credential.Type = $credentialTypeGeneric
            $credential.TargetName = $target
            $credential.Comment = "CoC Room DeepSeek API Key"
            $credential.CredentialBlobSize = [uint32]($secret.Length * 2)
            $credential.CredentialBlob = $secretPointer
            $credential.Persist = $credentialPersistEnterprise
            $credential.AttributeCount = 0
            $credential.Attributes = [IntPtr]::Zero
            $credential.TargetAlias = ""
            $credential.UserName = $account
            if (-not [CocRoom.NativeCredential]::CredWrite([ref]$credential, 0)) {
                throw "Unable to save the DeepSeek API Key in Windows Credential Manager."
            }
        }
        finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($secretPointer)
            $secret.Dispose()
        }
        Write-Output "DeepSeek API Key saved in Windows Credential Manager."
    }
}
