# Code signing

The installer ships unsigned, so Windows SmartScreen warns on first run. This
is what it would take to remove that warning, and how to turn signing on once
you have a certificate.

Nothing here is required to build or use Cuepull.

## What the warning actually is

SmartScreen checks a file's reputation. An unsigned file from a new source has
none, so Windows warns. Signing attaches a verified identity to the file, and
reputation then accrues to the certificate rather than to each individual
build.

Two things worth knowing before spending money:

- A standard (OV) certificate does **not** remove the warning immediately. The
  certificate has to build reputation first, which takes a few hundred installs
  and sometimes several weeks.
- An EV certificate gets instant reputation, and costs roughly twice as much.

## Options

| Option | Cost | Removes warning | Notes |
|---|---|---|---|
| Do nothing | free | no | Publish checksums instead. Fine for open source. |
| Azure Trusted Signing | ~$10/month | after reputation | Cheapest real option. Needs a business entity 3+ years old. |
| OV certificate | ~$200 to $400/year | after reputation | Hardware token or cloud HSM required since June 2023. |
| EV certificate | ~$400 to $700/year | immediately | Business verification plus hardware token. |

Since June 2023 every new code signing certificate must live on hardware, so
there is no downloadable `.pfx` anymore. You either get a USB token in the post
or sign through a cloud HSM.

## Turning it on

`package.json` already carries the signing options under `build.win`.
electron-builder reads the certificate from environment variables and skips
signing entirely when they are absent, so an unsigned build needs no changes.

With a certificate file:

```powershell
$env:CSC_LINK = "C:\path\to\cert.pfx"
$env:CSC_KEY_PASSWORD = "your-password"
npm run dist
```

In CI, base64 encode the certificate and put it in `CSC_LINK` as a secret,
with the password in `CSC_KEY_PASSWORD`.

With a hardware token or cloud HSM the flow is provider specific. Most supply
a signing tool you point electron-builder at with `build.win.sign`, pointing to
a small JavaScript file that shells out to their signer.

Then confirm it worked:

```powershell
Get-AuthenticodeSignature "dist\Cuepull Setup 1.0.0.exe" | Format-List Status, SignerCertificate
```

`Status` should read `Valid`.

## Timestamping

`rfc3161TimeStampServer` is already set to DigiCert's server. Timestamping
matters: without it, every signature stops validating the day the certificate
expires, including on copies people already downloaded. With it, signatures
stay valid past expiry.

## What signing does not cover

Signing the installer does not sign the executables inside it. `yt-dlp.exe` and
`ffmpeg.exe` are already signed by their own publishers, and the build is
configured not to re-sign them. If you ever bundle another binary, Windows
evaluates it separately.
