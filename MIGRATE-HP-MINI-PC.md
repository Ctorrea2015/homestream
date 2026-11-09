# 🖥️ HomeStream — HP Mini PC Setup Guide

Move the whole app from the big PC to the HP mini PC in ~15 minutes.
Do the steps **in order**, one block at a time.

---

## 1. Install Node.js on the mini PC

1. Open the browser on the mini PC and go to: **https://nodejs.org**
2. Download the **LTS** Windows installer (`.msi`), run it, Next → Next → Install.

Check it worked — open **PowerShell** (Start → type `powershell`) and paste:

```powershell
node --version
```

You should see a version number like `v22.x.x`. If yes, go on.

---

## 2. Get the app from GitHub

Still in PowerShell:

```powershell
cd $HOME\Documents
git clone https://github.com/Ctorrea2015/homestream.git
cd homestream
npm install
npm run build
```

(`npm run build` takes 1–2 minutes. Fix if it errors: you skipped nothing.)

---

## 3. Bring your private data over

On the **big PC**, the folder with everything you've saved lives at:

```
C:\Users\Tomex Construction\Downloads\streaming app\.data
```

Copy the **whole `.data` folder** to a USB stick and paste it into the mini PC's
`homestream` folder (next to `package.json`). It contains your IPTV login,
continue-watching, addons list, library index, and settings.

> That folder never goes to GitHub by design — that's why we copy it by hand.

---

## 4. Start it for a test

```powershell
npm run start
```

Open `http://localhost:3000` on the mini PC's browser. Play something.
Then close the app (Ctrl+C in PowerShell) and do step 5 so you never need to
type this again.

---

## 5. Auto-start on boot (so it's a real "server")

Create the startup task — paste the whole block, one Enter at the end:

```powershell
$action  = New-ScheduledTaskAction -Execute "cmd.exe" `
  -Argument '/c cd /d "%USERPROFILE%\Documents\homestream" && npm run start'
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName "HomeStream" -Action $action -Trigger $trigger -Settings $settings
```

This makes the app start silently **every time the mini PC turns on**.

---

## 6. Wi-Fi + remote access (Tailscale)

**At home:** the app is already reachable from phones/tablets on the same Wi-Fi at
the mini PC's IP — find it by pasting:

```powershell
ipconfig | Select-String "IPv4"
```

Use that IP + `:3000` on any device at home. (This IP can change once in a while;
if the app "disappears," rerun the command above to get the new number.)

**From anywhere in the world:**

1. Install **Tailscale** on the mini PC **and** your phone: **https://tailscale.com/download**
2. Sign both into the same Tailscale account (free tier covers you).
3. On your phone, the app is then at the mini PC's Tailscale IP + `:3000`
   — find it with `tailscale ip -4` on the mini PC.
4. Allow HomeStream through Windows Firewall once:

```powershell
New-NetFirewallRule -DisplayName "HomeStream" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
```

That's it — every phone in the house and anywhere you travel uses the same app.

---

## 7. Keep both copies in sync

Any time a new fix/push lands on GitHub, on the mini PC just:

```powershell
cd $HOME\Documents\homestream
git pull
npm install      # only if npm says so
npm run build
```

Restart it (or reboot) and both machines run the same version.

---

## ✅ Done — final check

- [ ] `http://localhost:3000` works on the mini PC
- [ ] Continue Watching, IPTV login, addons all still show (they came from `.data/`)
- [ ] Phone plays a movie from the mini PC over Wi-Fi
- [ ] Phone plays a movie over Tailscale (mobile data off Wi-Fi)
- [ ] App auto-starts after a reboot without you touching anything

Then shut the big PC down — the mini PC is the server now. 🍿
