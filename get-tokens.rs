// Standalone Rust utility to extract Apple tokens from Windows keychain
// Compile: rustc get-tokens.rs -o get-tokens.exe
// Run: .\get-tokens.exe

use std::process::Command;

fn main() {
    let service = "dev.aScrobble.app";
    
    // Windows uses Credential Manager (via cmdkey or vaultcli)
    // The keyring crate stores as generic credentials
    
    println!("Searching for aScrobble credentials...");
    
    // Try using PowerShell to read the credential
    let ps_script = format!(
        r#"
        $cred = Get-StoredCredential -Target "{}" -ErrorAction SilentlyContinue
        if ($cred) {{
            Write-Output "TARGET:$($cred.TargetName)"
            Write-Output "USER:$($cred.UserName)"
            # Note: Password cannot be retrieved easily
        }} else {{
            Write-Output "NOT_FOUND"
        }}
        "#,
        service
    );
    
    match Command::new("powershell")
        .args(&["-Command", &ps_script])
        .output() 
    {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            println!("Result: {}", stdout.trim());
        }
        Err(e) => {
            println!("Error: {}", e);
        }
    }
    
    // Alternative: direct registry/file inspection hint
    println!("\nAlternative: Check these locations:");
    println!("  1. Windows Credential Manager (control /name Microsoft.CredentialManager)");
    println!("  2. Look for 'dev.aScrobble.app' entries");
    println!("  3. The tokens are stored as 'apple_dev_token' and 'apple_music_user_token'");
}
